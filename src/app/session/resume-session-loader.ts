import { open, readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { getAgentDir, type SessionInfo } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../guards.js";

const DEFAULT_INITIAL_CHUNK_SIZE = 20;
const DEFAULT_CHUNK_SIZE = 10;

export type ResumeSessionLoadProgress = {
	loaded: number;
	total: number;
	done: boolean;
};

export type ResumeSessionLoaderOptions = {
	cwd: string;
	sessionDir?: string;
	initialChunkSize?: number;
	chunkSize?: number;
	signal?: AbortSignal;
	onChunk(sessions: readonly SessionInfo[], progress: ResumeSessionLoadProgress): void;
};

type SessionFile = {
	path: string;
	mtime: Date;
};

export async function loadResumeSessionsInChunks(options: ResumeSessionLoaderOptions): Promise<SessionInfo[]> {
	const initialChunkSize = positiveInteger(options.initialChunkSize, DEFAULT_INITIAL_CHUNK_SIZE);
	const chunkSize = positiveInteger(options.chunkSize, DEFAULT_CHUNK_SIZE);
	const files = await listSessionFiles(options.cwd, options.sessionDir);
	const sessions: SessionInfo[] = [];

	if (files.length === 0) {
		options.onChunk([], { loaded: 0, total: 0, done: true });
		return [];
	}

	let index = 0;
	let currentChunkSize = initialChunkSize;
	while (index < files.length) {
		if (options.signal?.aborted) break;

		const chunk = files.slice(index, index + currentChunkSize);
		const infos = await Promise.all(chunk.map((file) => buildSessionInfo(file)));
		for (const info of infos) {
			if (info) sessions.push(info);
		}
		sessions.sort(compareSessionsByModifiedDesc);

		index += currentChunkSize;
		const done = index >= files.length || options.signal?.aborted === true;
		options.onChunk([...sessions], { loaded: Math.min(index, files.length), total: files.length, done });

		currentChunkSize = chunkSize;
		if (!done) await nextTick();
	}

	return [...sessions];
}

async function listSessionFiles(cwd: string, sessionDir?: string): Promise<SessionFile[]> {
	const dir = sessionDir ? resolve(sessionDir) : getDefaultSessionDir(cwd);
	const defaultDir = getDefaultSessionDir(cwd);
	const shouldFilterCwd = sessionDir !== undefined && resolve(dir) !== resolve(defaultDir);
	const resolvedCwd = resolve(cwd);

	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const files = await Promise.all(entries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
			.map(async (entry): Promise<SessionFile | undefined> => {
				const path = join(dir, entry.name);
				try {
					const stats = await stat(path);
					if (shouldFilterCwd) {
						const header = await readSessionHeader(path);
						if (!header || !sessionCwdMatches(header.cwd, resolvedCwd)) return undefined;
					}
					return { path, mtime: stats.mtime };
				} catch {
					return undefined;
				}
			}));

		return files
			.filter((file): file is SessionFile => file !== undefined)
			.sort((left, right) => right.mtime.getTime() - left.mtime.getTime());
	} catch {
		return [];
	}
}

async function readSessionHeader(filePath: string): Promise<{ id: string; cwd?: string } | undefined> {
	try {
		const handle = await open(filePath, "r");
		try {
			const buffer = Buffer.alloc(4096);
			const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
			const firstLine = buffer.toString("utf8", 0, bytesRead).split("\n")[0];
			if (!firstLine) return undefined;
			const header = JSON.parse(firstLine) as unknown;
			if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return undefined;
			return typeof header.cwd === "string" ? { id: header.id, cwd: header.cwd } : { id: header.id };
		} finally {
			await handle.close();
		}
	} catch {
		return undefined;
	}
}

function getDefaultSessionDir(cwd: string): string {
	const resolvedCwd = resolve(cwd);
	const safePath = `--${resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
	return join(resolve(getAgentDir()), "sessions", safePath);
}

async function buildSessionInfo(file: SessionFile): Promise<SessionInfo | undefined> {
	try {
		const content = await readFile(file.path, "utf8");
		const entries = parseJsonLines(content);
		const header = entries[0];
		if (!isRecord(header) || header.type !== "session" || typeof header.id !== "string") return undefined;

		let messageCount = 0;
		let firstMessage = "";
		let name: string | undefined;
		const allMessages: string[] = [];
		let lastActivityTime: number | undefined;

		for (const entry of entries) {
			if (!isRecord(entry)) continue;

			if (entry.type === "session_info") {
				name = typeof entry.name === "string" ? entry.name.trim() || undefined : undefined;
				continue;
			}

			if (entry.type !== "message" || !isRecord(entry.message)) continue;
			messageCount++;
			const message = entry.message;
			const role = message.role;
			if (role !== "user" && role !== "assistant") continue;

			const textContent = extractTextContent(message.content);
			if (textContent) {
				allMessages.push(textContent);
				if (!firstMessage && role === "user") firstMessage = textContent;
			}

			lastActivityTime = latestTimestamp(lastActivityTime, message.timestamp);
			lastActivityTime = latestTimestamp(lastActivityTime, entry.timestamp);
		}

		const headerTimestamp = typeof header.timestamp === "string" ? new Date(header.timestamp).getTime() : NaN;
		const modified = typeof lastActivityTime === "number"
			? new Date(lastActivityTime)
			: (!Number.isNaN(headerTimestamp) ? new Date(headerTimestamp) : file.mtime);

		return {
			path: file.path,
			id: header.id,
			cwd: typeof header.cwd === "string" ? header.cwd : "",
			...(name === undefined ? {} : { name }),
			...(typeof header.parentSession === "string" ? { parentSessionPath: header.parentSession } : {}),
			created: new Date(typeof header.timestamp === "string" ? header.timestamp : file.mtime),
			modified,
			messageCount,
			firstMessage: firstMessage || "(no messages)",
			allMessagesText: allMessages.join(" "),
		};
	} catch {
		return undefined;
	}
}

function parseJsonLines(content: string): unknown[] {
	const entries: unknown[] = [];
	for (const line of content.trim().split("\n")) {
		if (!line.trim()) continue;
		try {
			entries.push(JSON.parse(line) as unknown);
		} catch {
			// Ignore malformed lines, matching SDK session listing behavior.
		}
	}
	return entries;
}

function extractTextContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.map((block) => isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : "")
		.filter(Boolean)
		.join(" ");
}

function latestTimestamp(current: number | undefined, value: unknown): number | undefined {
	let timestamp: number | undefined;
	if (typeof value === "number") timestamp = value;
	else if (typeof value === "string") {
		const parsed = new Date(value).getTime();
		if (!Number.isNaN(parsed)) timestamp = parsed;
	}
	if (timestamp === undefined) return current;
	return Math.max(current ?? 0, timestamp);
}

function sessionCwdMatches(cwd: string | undefined, resolvedCwd: string): boolean {
	return cwd !== undefined && cwd !== "" && resolve(cwd) === resolvedCwd;
}

function compareSessionsByModifiedDesc(left: SessionInfo, right: SessionInfo): number {
	return right.modified.getTime() - left.modified.getTime();
}

function positiveInteger(value: number | undefined, fallback: number): number {
	if (value === undefined || !Number.isFinite(value) || value < 1) return fallback;
	return Math.floor(value);
}

function nextTick(): Promise<void> {
	return new Promise((resolveTick) => {
		setImmediate(resolveTick);
	});
}
