import { randomUUID } from "node:crypto";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
	buildSessionContext,
	SessionManager,
	type NewSessionOptions,
	type SessionContext,
	type SessionEntry,
	type SessionHeader,
} from "@earendil-works/pi-coding-agent";

import { isRecord } from "../guards.js";

const CURRENT_SESSION_VERSION = 3;
const DEFAULT_TAIL_ENTRY_COUNT = 180;
const INITIAL_TAIL_BYTES = 256 * 1024;
const MAX_TAIL_BYTES = 16 * 1024 * 1024;

export type LazySessionManagerOptions = {
	cwdOverride?: string;
	sessionDir?: string;
	tailEntryCount?: number;
};

export function openLazySessionManager(sessionPath: string, options: LazySessionManagerOptions = {}): SessionManager {
	return new LazySessionManager(sessionPath, options) as unknown as SessionManager;
}

class LazySessionManager {
	private sessionFilePath: string;
	private sessionDirPath: string;
	private cwdPath: string;
	private header: SessionHeader;
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	private labelsById = new Map<string, string>();
	private labelTimestampsById = new Map<string, string>();
	private leafId: string | null = null;
	private hydrated: SessionManager | undefined;
	private readonly tailEntryCount: number;

	constructor(sessionPath: string, options: LazySessionManagerOptions = {}) {
		this.sessionFilePath = resolve(sessionPath);
		this.sessionDirPath = resolve(options.sessionDir ?? dirname(this.sessionFilePath));
		this.tailEntryCount = Math.max(1, Math.floor(options.tailEntryCount ?? DEFAULT_TAIL_ENTRY_COUNT));
		this.header = this.loadHeader(options.cwdOverride);
		this.cwdPath = resolve(options.cwdOverride ?? this.header.cwd ?? process.cwd());
		this.loadTailEntries();
	}

	setSessionFile(sessionFile: string): void {
		if (this.hydrated) {
			this.hydrated.setSessionFile(sessionFile);
			return;
		}

		this.sessionFilePath = resolve(sessionFile);
		this.sessionDirPath = dirname(this.sessionFilePath);
		this.header = this.loadHeader(this.cwdPath);
		this.cwdPath = resolve(this.header.cwd || this.cwdPath);
		this.loadTailEntries();
	}

	newSession(options?: NewSessionOptions): string | undefined {
		if (this.hydrated) return this.hydrated.newSession(options);

		const timestamp = new Date().toISOString();
		const sessionId = options?.id ?? createSessionId();
		const header: SessionHeader = {
			type: "session",
			version: CURRENT_SESSION_VERSION,
			id: sessionId,
			timestamp,
			cwd: this.cwdPath,
		};
		if (options?.parentSession !== undefined) header.parentSession = options.parentSession;

		this.header = header;
		this.entries = [];
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;

		mkdirSync(this.sessionDirPath, { recursive: true });
		this.sessionFilePath = join(this.sessionDirPath, `${timestamp.replace(/[:.]/g, "-")}_${sessionId}.jsonl`);
		writeFileSync(this.sessionFilePath, `${JSON.stringify(header)}\n`, "utf8");
		return this.sessionFilePath;
	}

	isPersisted(): boolean {
		return true;
	}

	getCwd(): string {
		return this.hydrated?.getCwd() ?? this.cwdPath;
	}

	getSessionDir(): string {
		return this.hydrated?.getSessionDir() ?? this.sessionDirPath;
	}

	usesDefaultSessionDir(): boolean {
		return this.hydrated?.usesDefaultSessionDir() ?? false;
	}

	getSessionId(): string {
		return this.hydrated?.getSessionId() ?? this.header.id;
	}

	getSessionFile(): string | undefined {
		return this.hydrated?.getSessionFile() ?? this.sessionFilePath;
	}

	getHeader(): SessionHeader | null {
		return this.hydrated?.getHeader() ?? this.header;
	}

	getEntries(): SessionEntry[] {
		return this.hydrated?.getEntries() ?? [...this.entries];
	}

	getBranch(fromId?: string): SessionEntry[] {
		if (this.hydrated) return this.hydrated.getBranch(fromId);
		if (fromId !== undefined && !this.byId.has(fromId)) return this.hydrate().getBranch(fromId);
		return [...this.entries];
	}

	buildSessionContext(): SessionContext {
		if (this.hydrated) return this.hydrated.buildSessionContext();
		const entries = this.contextEntries();
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		return buildSessionContext(entries, entries.at(-1)?.id ?? null, byId);
	}

	getSessionName(): string | undefined {
		if (this.hydrated) return this.hydrated.getSessionName();
		for (let index = this.entries.length - 1; index >= 0; index -= 1) {
			const entry = this.entries[index];
			if (entry?.type === "session_info") return entry.name?.trim() || undefined;
		}
		return undefined;
	}

	getLeafId(): string | null {
		return this.hydrated?.getLeafId() ?? this.leafId;
	}

	getLeafEntry(): SessionEntry | undefined {
		if (this.hydrated) return this.hydrated.getLeafEntry();
		return this.leafId ? this.byId.get(this.leafId) : undefined;
	}

	getEntry(id: string): SessionEntry | undefined {
		if (this.hydrated) return this.hydrated.getEntry(id);
		return this.byId.get(id) ?? this.hydrate().getEntry(id);
	}

	getChildren(parentId: string): SessionEntry[] {
		if (this.hydrated) return this.hydrated.getChildren(parentId);
		return this.entries.filter((entry) => entry.parentId === parentId);
	}

	getLabel(id: string): string | undefined {
		return this.hydrated?.getLabel(id) ?? this.labelsById.get(id);
	}

	getTree(): ReturnType<SessionManager["getTree"]> {
		return this.hydrate().getTree();
	}

	branch(branchFromId: string): void {
		if (!this.byId.has(branchFromId)) {
			this.hydrate().branch(branchFromId);
			return;
		}
		this.leafId = branchFromId;
	}

	resetLeaf(): void {
		if (this.hydrated) {
			this.hydrated.resetLeaf();
			return;
		}
		this.leafId = null;
	}

	createBranchedSession(leafId: string): string | undefined {
		return this.hydrate().createBranchedSession(leafId);
	}

	branchWithSummary(branchFromId: string | null, summary: string, details?: unknown, fromHook?: boolean): string {
		return this.hydrate().branchWithSummary(branchFromId, summary, details, fromHook);
	}

	appendLabelChange(targetId: string, label: string | undefined): string {
		if (this.hydrated) return this.hydrated.appendLabelChange(targetId, label);
		if (!this.byId.has(targetId)) return this.hydrate().appendLabelChange(targetId, label);

		const entry = this.newEntry("label", { targetId, label });
		this.appendEntry(entry);
		if (label) {
			this.labelsById.set(targetId, label);
			this.labelTimestampsById.set(targetId, entry.timestamp);
		} else {
			this.labelsById.delete(targetId);
			this.labelTimestampsById.delete(targetId);
		}
		return entry.id;
	}

	appendMessage(message: unknown): string {
		if (this.hydrated) return this.hydrated.appendMessage(message as never);
		return this.appendEntry(this.newEntry("message", { message }));
	}

	appendThinkingLevelChange(thinkingLevel: string): string {
		if (this.hydrated) return this.hydrated.appendThinkingLevelChange(thinkingLevel);
		return this.appendEntry(this.newEntry("thinking_level_change", { thinkingLevel }));
	}

	appendModelChange(provider: string, modelId: string): string {
		if (this.hydrated) return this.hydrated.appendModelChange(provider, modelId);
		return this.appendEntry(this.newEntry("model_change", { provider, modelId }));
	}

	appendCompaction<T = unknown>(summary: string, firstKeptEntryId: string, tokensBefore: number, details?: T, fromHook?: boolean): string {
		if (this.hydrated) return this.hydrated.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, fromHook);
		const payload: Record<string, unknown> = { summary, firstKeptEntryId, tokensBefore };
		if (details !== undefined) payload.details = details;
		if (fromHook !== undefined) payload.fromHook = fromHook;
		return this.appendEntry(this.newEntry("compaction", payload));
	}

	appendCustomEntry(customType: string, data?: unknown): string {
		if (this.hydrated) return this.hydrated.appendCustomEntry(customType, data);
		const payload: Record<string, unknown> = { customType };
		if (data !== undefined) payload.data = data;
		return this.appendEntry(this.newEntry("custom", payload));
	}

	appendSessionInfo(name: string): string {
		if (this.hydrated) return this.hydrated.appendSessionInfo(name);
		return this.appendEntry(this.newEntry("session_info", { name: name.trim() }));
	}

	appendCustomMessageEntry<T = unknown>(customType: string, content: unknown, display: boolean, details?: T): string {
		if (this.hydrated) return this.hydrated.appendCustomMessageEntry(customType, content as never, display, details);
		const payload: Record<string, unknown> = { customType, content, display };
		if (details !== undefined) payload.details = details;
		return this.appendEntry(this.newEntry("custom_message", payload));
	}

	private hydrate(): SessionManager {
		if (!this.hydrated) {
			this.hydrated = SessionManager.open(this.sessionFilePath, this.sessionDirPath, this.cwdPath);
		}
		return this.hydrated;
	}

	private loadHeader(cwdOverride: string | undefined): SessionHeader {
		if (!existsSync(this.sessionFilePath)) {
			mkdirSync(dirname(this.sessionFilePath), { recursive: true });
			const header = createSessionHeader(resolve(cwdOverride ?? process.cwd()));
			writeFileSync(this.sessionFilePath, `${JSON.stringify(header)}\n`, "utf8");
			return header;
		}

		const header = readSessionHeaderFast(this.sessionFilePath);
		return header ?? createSessionHeader(resolve(cwdOverride ?? process.cwd()));
	}

	private loadTailEntries(): void {
		this.entries = readTailSessionEntries(this.sessionFilePath, this.tailEntryCount);
		this.rebuildIndexes();
	}

	private rebuildIndexes(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.labelTimestampsById.clear();
		this.leafId = null;

		for (const entry of this.entries) {
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
					this.labelTimestampsById.set(entry.targetId, entry.timestamp);
				} else {
					this.labelsById.delete(entry.targetId);
					this.labelTimestampsById.delete(entry.targetId);
				}
			}
		}
	}

	private appendEntry(entry: SessionEntry): string {
		this.entries.push(entry);
		this.byId.set(entry.id, entry);
		this.leafId = entry.id;
		appendFileSync(this.sessionFilePath, `${JSON.stringify(entry)}\n`, "utf8");
		return entry.id;
	}

	private newEntry(type: string, payload: Record<string, unknown>): SessionEntry {
		return {
			type,
			id: this.createEntryId(),
			parentId: this.leafId,
			timestamp: new Date().toISOString(),
			...payload,
		} as unknown as SessionEntry;
	}

	private createEntryId(): string {
		for (let attempt = 0; attempt < 100; attempt += 1) {
			const id = randomUUID().slice(0, 8);
			if (!this.byId.has(id)) return id;
		}
		return randomUUID();
	}

	private contextEntries(): SessionEntry[] {
		const entries = this.entries.filter((entry) => entry.type !== "label");
		const start = contextStartIndex(entries);
		const selected = entries.slice(start);
		return selected.map((entry, index) => ({
			...entry,
			parentId: index === 0 ? null : selected[index - 1]!.id,
		} as SessionEntry));
	}
}

function createSessionHeader(cwd: string): SessionHeader {
	return {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: createSessionId(),
		timestamp: new Date().toISOString(),
		cwd,
	};
}

function createSessionId(): string {
	return randomUUID();
}

function readSessionHeaderFast(filePath: string): SessionHeader | undefined {
	const line = readFirstLine(filePath, 64 * 1024);
	if (!line) return undefined;
	try {
		const parsed = JSON.parse(line) as unknown;
		if (!isRecord(parsed) || parsed.type !== "session" || typeof parsed.id !== "string") return undefined;
		const header = parsed as unknown as SessionHeader;
		return typeof header.cwd === "string" ? header : { ...header, cwd: process.cwd() };
	} catch {
		return undefined;
	}
}

function readFirstLine(filePath: string, maxBytes: number): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(filePath, "r");
		const buffer = Buffer.alloc(maxBytes);
		const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, bytesRead);
		return text.split("\n")[0];
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function readTailSessionEntries(filePath: string, limit: number): SessionEntry[] {
	if (!existsSync(filePath)) return [];
	const size = statSync(filePath).size;
	if (size <= 0) return [];

	let byteCount = Math.min(size, INITIAL_TAIL_BYTES);
	const maxBytes = Math.min(size, MAX_TAIL_BYTES);
	while (byteCount <= maxBytes) {
		const entries = readTailSessionEntriesWithByteCount(filePath, byteCount, limit);
		if (entries.length >= limit || byteCount >= maxBytes || byteCount >= size) return entries.slice(-limit);
		byteCount = Math.min(size, Math.max(byteCount + 1, byteCount * 2));
	}

	return [];
}

function readTailSessionEntriesWithByteCount(filePath: string, byteCount: number, limit: number): SessionEntry[] {
	let fd: number | undefined;
	try {
		const size = statSync(filePath).size;
		const start = Math.max(0, size - byteCount);
		const buffer = Buffer.alloc(size - start);
		fd = openSync(filePath, "r");
		readSync(fd, buffer, 0, buffer.length, start);

		let text = buffer.toString("utf8");
		if (start > 0) {
			const firstNewline = text.indexOf("\n");
			text = firstNewline >= 0 ? text.slice(firstNewline + 1) : "";
		}

		const entries: SessionEntry[] = [];
		for (const line of text.split("\n")) {
			const entry = parseSessionEntryLine(line);
			if (entry) entries.push(entry);
		}
		return entries.slice(-limit);
	} catch {
		return [];
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function parseSessionEntryLine(line: string): SessionEntry | undefined {
	const trimmed = line.trim();
	if (!trimmed) return undefined;
	try {
		const parsed = JSON.parse(trimmed) as unknown;
		if (!isRecord(parsed) || parsed.type === "session" || typeof parsed.id !== "string") return undefined;
		return parsed as unknown as SessionEntry;
	} catch {
		return undefined;
	}
}

function contextStartIndex(entries: readonly SessionEntry[]): number {
	const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
	if (userIndex < 0) return 0;

	let start = userIndex;
	while (start > 0) {
		const previous = entries[start - 1];
		if (!previous || (previous.type !== "model_change" && previous.type !== "thinking_level_change" && previous.type !== "compaction" && previous.type !== "branch_summary")) break;
		start -= 1;
	}
	return start;
}
