import { randomUUID } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdir, open as openFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

import {
	buildContextEntries as buildSdkContextEntries,
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

export type LazySessionHistoryReader = {
	hasOlder(): boolean;
	readOlder(limit: number): Promise<SessionEntry[]>;
};

export async function openLazySessionManager(sessionPath: string, options: LazySessionManagerOptions = {}): Promise<SessionManager> {
	return await LazySessionManager.open(sessionPath, options) as unknown as SessionManager;
}

type SessionManagerFacade = Omit<SessionManager, "_persist">;

class LazySessionManager implements SessionManagerFacade {
	private sessionFilePath: string;
	private sessionDirPath: string;
	private cwdPath: string;
	private header: SessionHeader;
	private entries: SessionEntry[] = [];
	private byId = new Map<string, SessionEntry>();
	private labelsById = new Map<string, string>();
	private leafId: string | null = null;
	private hydrated: SessionManager | undefined;
	private readonly tailEntryCount: number;
	private tailStartOffset = 0;

	constructor(sessionPath: string, options: LazySessionManagerOptions = {}) {
		this.sessionFilePath = resolve(sessionPath);
		this.sessionDirPath = resolve(options.sessionDir ?? dirname(this.sessionFilePath));
		this.tailEntryCount = Math.max(1, Math.floor(options.tailEntryCount ?? DEFAULT_TAIL_ENTRY_COUNT));
		this.cwdPath = resolve(options.cwdOverride ?? process.cwd());
		this.header = createSessionHeader(this.cwdPath);
	}

	static async open(sessionPath: string, options: LazySessionManagerOptions = {}): Promise<LazySessionManager> {
		const manager = new LazySessionManager(sessionPath, options);
		await manager.initialize(options.cwdOverride);
		return manager;
	}

	private async initialize(cwdOverride: string | undefined): Promise<void> {
		this.header = await this.loadHeaderAsync(cwdOverride);
		this.cwdPath = resolve(cwdOverride ?? this.header.cwd ?? process.cwd());
		if ((this.header.version ?? 1) < CURRENT_SESSION_VERSION) {
			this.hydrated = SessionManager.open(this.sessionFilePath, this.sessionDirPath, this.cwdPath);
			this.header = this.hydrated.getHeader() ?? this.header;
			return;
		}
		await this.loadTailEntriesAsync();
	}

	setSessionFile(sessionFile: string): void {
		if (this.hydrated) {
			this.hydrated.setSessionFile(sessionFile);
			return;
		}

		this.sessionFilePath = resolve(sessionFile);
		this.sessionDirPath = dirname(this.sessionFilePath);
		throw new Error("LazySessionManager.setSessionFile() before hydration is unsupported");
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
		if (fromId === undefined) return [...this.entries];
		if (fromId !== undefined && !this.byId.has(fromId)) return this.hydrate().getBranch(fromId);
		return [...this.entries];
	}

	createHistoryReader(): LazySessionHistoryReader | undefined {
		if (this.hydrated || this.tailStartOffset <= 0) return undefined;

		let cursorOffset = this.tailStartOffset;
		let firstEntryOffset = 0;
		let firstEntryOffsetPromise: Promise<number> | undefined;
		const loadFirstEntryOffset = async (): Promise<number> => {
			firstEntryOffsetPromise ??= readFirstSessionEntryOffset(this.sessionFilePath).then((offset) => {
				firstEntryOffset = offset;
				return offset;
			});
			return await firstEntryOffsetPromise;
		};
		return {
			hasOlder: () => cursorOffset > firstEntryOffset,
			readOlder: async (limit: number) => {
				const resolvedFirstEntryOffset = await loadFirstEntryOffset();
				if (cursorOffset <= resolvedFirstEntryOffset) return [];
				const result = await readSessionEntriesBeforeOffset(this.sessionFilePath, cursorOffset, Math.max(1, Math.floor(limit)));
				cursorOffset = result.startOffset;
				if (result.entries.length === 0) cursorOffset = resolvedFirstEntryOffset;
				return result.entries;
			},
		};
	}

	async readFullBranchEntries(): Promise<SessionEntry[]> {
		if (this.hydrated) return this.hydrated.getBranch();

		const entries = await readAllSessionEntries(this.sessionFilePath);
		return branchEntries(entries, this.leafId ?? entries.at(-1)?.id);
	}

	async readFullSessionEntries(): Promise<SessionEntry[]> {
		if (this.hydrated) return this.hydrated.getEntries();
		return readAllSessionEntries(this.sessionFilePath);
	}

	buildContextEntries(): SessionEntry[] {
		if (this.hydrated) return this.hydrated.buildContextEntries();
		const entries = this.contextEntries();
		const byId = new Map(entries.map((entry) => [entry.id, entry]));
		return buildSdkContextEntries(entries, entries.at(-1)?.id ?? null, byId);
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
		} else {
			this.labelsById.delete(targetId);
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

	private async loadHeaderAsync(cwdOverride: string | undefined): Promise<SessionHeader> {
		const existingHeader = await readSessionHeaderFast(this.sessionFilePath);
		if (existingHeader) return existingHeader;

		await mkdir(dirname(this.sessionFilePath), { recursive: true });
		const header = createSessionHeader(resolve(cwdOverride ?? process.cwd()));
		await writeFile(this.sessionFilePath, `${JSON.stringify(header)}\n`, "utf8");
		return header;
	}

	private async loadTailEntriesAsync(): Promise<void> {
		const result = await readTailSessionEntries(this.sessionFilePath, this.tailEntryCount);
		this.entries = result.entries;
		this.tailStartOffset = result.startOffset;
		this.rebuildIndexes();
	}

	private rebuildIndexes(): void {
		this.byId.clear();
		this.labelsById.clear();
		this.leafId = null;

		for (const entry of this.entries) {
			this.byId.set(entry.id, entry);
			this.leafId = entry.id;
			if (entry.type === "label") {
				if (entry.label) {
					this.labelsById.set(entry.targetId, entry.label);
				} else {
					this.labelsById.delete(entry.targetId);
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

async function readSessionHeaderFast(filePath: string): Promise<SessionHeader | undefined> {
	const line = await readFirstLine(filePath, 64 * 1024);
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

async function readFirstLine(filePath: string, maxBytes: number): Promise<string | undefined> {
	let file: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		file = await openFile(filePath, "r");
		const buffer = Buffer.alloc(maxBytes);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const text = buffer.toString("utf8", 0, bytesRead);
		return text.split("\n")[0];
	} catch {
		return undefined;
	} finally {
		await file?.close();
	}
}

async function readFirstSessionEntryOffset(filePath: string): Promise<number> {
	let file: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		file = await openFile(filePath, "r");
		const buffer = Buffer.alloc(64 * 1024);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		const entries = parseSessionEntryBufferLines(buffer.subarray(0, bytesRead), 0);
		return entries[0]?.offset ?? 0;
	} catch {
		return 0;
	} finally {
		await file?.close();
	}
}

type SessionEntriesReadResult = {
	entries: SessionEntry[];
	startOffset: number;
};

async function readTailSessionEntries(filePath: string, limit: number): Promise<SessionEntriesReadResult> {
	const size = await stat(filePath).then((result) => result.size).catch(() => 0);
	if (size <= 0) return { entries: [], startOffset: 0 };

	let byteCount = Math.min(size, INITIAL_TAIL_BYTES);
	const maxBytes = Math.min(size, MAX_TAIL_BYTES);
	while (byteCount <= maxBytes) {
		const result = await readTailSessionEntriesWithByteCount(filePath, byteCount, limit, size);
		if (result.entries.length >= limit || byteCount >= maxBytes || byteCount >= size) return result;
		byteCount = Math.min(size, Math.max(byteCount + 1, byteCount * 2));
	}

	return { entries: [], startOffset: 0 };
}

async function readTailSessionEntriesWithByteCount(filePath: string, byteCount: number, limit: number, size: number): Promise<SessionEntriesReadResult> {
	let file: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		const start = Math.max(0, size - byteCount);
		const buffer = Buffer.alloc(size - start);
		file = await openFile(filePath, "r");
		await file.read(buffer, 0, buffer.length, start);

		let parseStart = 0;
		if (start > 0) {
			const firstNewline = buffer.indexOf(10);
			parseStart = firstNewline >= 0 ? firstNewline + 1 : buffer.length;
		}

		return selectLastSessionEntries(parseSessionEntryBufferLines(buffer.subarray(parseStart), start + parseStart), limit, start, size);
	} catch {
		return { entries: [], startOffset: 0 };
	} finally {
		await file?.close();
	}
}

async function readSessionEntriesBeforeOffset(filePath: string, endOffset: number, limit: number): Promise<SessionEntriesReadResult> {
	if (endOffset <= 0) return { entries: [], startOffset: 0 };
	const exists = await stat(filePath).then(() => true).catch(() => false);
	if (!exists) return { entries: [], startOffset: 0 };

	let byteCount = Math.min(endOffset, INITIAL_TAIL_BYTES);
	const maxBytes = Math.min(endOffset, MAX_TAIL_BYTES);
	while (byteCount <= maxBytes) {
		const result = await readSessionEntriesBeforeOffsetWithByteCount(filePath, endOffset, byteCount, limit);
		if (result.entries.length >= limit || byteCount >= endOffset) return result;
		if (byteCount >= maxBytes) return await readSessionEntriesBeforeOffsetStreaming(filePath, endOffset, limit);
		byteCount = Math.min(endOffset, Math.max(byteCount + 1, byteCount * 2));
	}

	return { entries: [], startOffset: 0 };
}

async function readSessionEntriesBeforeOffsetStreaming(filePath: string, endOffset: number, limit: number): Promise<SessionEntriesReadResult> {
	const selected: Array<{ entry: SessionEntry; offset: number }> = [];
	let offset = 0;
	const stream = createReadStream(filePath, { encoding: "utf8", start: 0, end: Math.max(0, endOffset - 1) });
	const lines = createInterface({ input: stream, crlfDelay: Infinity });

	try {
		for await (const line of lines) {
			const lineOffset = offset;
			offset += Buffer.byteLength(line, "utf8") + 1;
			if (lineOffset >= endOffset) break;

			const entry = parseSessionEntryLine(line);
			if (!entry) continue;
			selected.push({ entry, offset: lineOffset });
			if (selected.length > limit) selected.shift();
		}
	} finally {
		stream.destroy();
	}

	return {
		entries: selected.map((item) => item.entry),
		startOffset: selected[0]?.offset ?? 0,
	};
}

async function readSessionEntriesBeforeOffsetWithByteCount(filePath: string, endOffset: number, byteCount: number, limit: number): Promise<SessionEntriesReadResult> {
	let file: Awaited<ReturnType<typeof openFile>> | undefined;
	try {
		const start = Math.max(0, endOffset - byteCount);
		const buffer = Buffer.alloc(endOffset - start);
		file = await openFile(filePath, "r");
		await file.read(buffer, 0, buffer.length, start);

		let parseStart = 0;
		if (start > 0) {
			const firstNewline = buffer.indexOf(10);
			parseStart = firstNewline >= 0 ? firstNewline + 1 : buffer.length;
		}

		return selectLastSessionEntries(parseSessionEntryBufferLines(buffer.subarray(parseStart), start + parseStart), limit, start, start);
	} catch {
		return { entries: [], startOffset: 0 };
	} finally {
		await file?.close();
	}
}

function selectLastSessionEntries(
	parsedEntries: Array<{ entry: SessionEntry; offset: number }>,
	limit: number,
	windowStartOffset: number,
	emptyStartOffset: number,
): SessionEntriesReadResult {
	const selected = parsedEntries.slice(-limit);
	const hasOlderEntriesBeforeSelected = windowStartOffset > 0 || parsedEntries.length > selected.length;
	return {
		entries: selected.map((item) => item.entry),
		startOffset: hasOlderEntriesBeforeSelected ? selected[0]?.offset ?? emptyStartOffset : 0,
	};
}

function parseSessionEntryBufferLines(buffer: Buffer, baseOffset: number): Array<{ entry: SessionEntry; offset: number }> {
	const entries: Array<{ entry: SessionEntry; offset: number }> = [];
	let lineStart = 0;
	for (let index = 0; index <= buffer.length; index += 1) {
		if (index < buffer.length && buffer[index] !== 10) continue;
		const lineEnd = index > lineStart && buffer[index - 1] === 13 ? index - 1 : index;
		const entry = parseSessionEntryLine(buffer.toString("utf8", lineStart, lineEnd));
		if (entry) entries.push({ entry, offset: baseOffset + lineStart });
		lineStart = index + 1;
	}
	return entries;
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

async function readAllSessionEntries(filePath: string): Promise<SessionEntry[]> {
	if (!existsSync(filePath)) return [];

	const entries: SessionEntry[] = [];
	const lines = createInterface({ input: createReadStream(filePath, { encoding: "utf8" }), crlfDelay: Infinity });
	for await (const line of lines) {
		const entry = parseSessionEntryLine(line);
		if (entry) entries.push(entry);
	}
	return entries;
}

function branchEntries(entries: readonly SessionEntry[], leafId: string | undefined): SessionEntry[] {
	if (!leafId) return [...entries];

	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let cursor: string | null | undefined = leafId;
	while (cursor && !seen.has(cursor)) {
		seen.add(cursor);
		const entry = byId.get(cursor);
		if (!entry) break;
		branch.push(entry);
		cursor = entry.parentId;
	}
	return branch.reverse();
}

function contextStartIndex(entries: readonly SessionEntry[]): number {
	const userIndex = entries.findIndex((entry) => entry.type === "message" && entry.message.role === "user");
	if (userIndex < 0) return 0;

	let start = userIndex;
	while (start > 0) {
		const previous = entries[start - 1];
		if (!previous || (previous.type !== "model_change" && previous.type !== "thinking_level_change" && previous.type !== "compaction" && previous.type !== "branch_summary" && previous.type !== "custom")) break;
		start -= 1;
	}
	return start;
}
