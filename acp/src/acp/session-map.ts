/**
 * Persistent ACP↔pi session map.
 *
 * ACP clients (e.g. Zed) remember only the sessionId we hand out in
 * `session/new` / `session/fork`. To support `session/load`, `session/resume`
 * and `session/list` across adapter restarts, we persist the mapping to the
 * underlying pi session file in a small JSON file.
 *
 * The file format is `{ "version": 1, "sessions": [...] }`; unknown versions
 * are rejected (rather than silently wiped) to allow future migrations.
 */

import { readFile, rename, mkdir, writeFile, access } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Logger } from "../logging.js";

const FORMAT_VERSION = 1;

interface SessionMapFile {
	version: number;
	sessions: SessionMapRecord[];
}

export interface SessionMapRecord {
	/** ACP session id handed to the client. */
	sessionId: string;
	/** Absolute path of the pi session file (JSONL). */
	piSessionPath: string;
	/** pi-internal session id (informational). */
	piSessionId: string;
	/** Working directory the session was created with. */
	cwd: string;
	title?: string | undefined;
	/** ISO 8601 timestamp of the last activity. */
	updatedAt: string;
}

export class SessionMapStore {
	private readonly filePath: string;
	private readonly logger: Logger;
	/** Cached records keyed by sessionId; `null` until first read. */
	private cache: Map<string, SessionMapRecord> | null = null;

	constructor(filePath: string, logger: Logger) {
		this.filePath = filePath;
		this.logger = logger;
	}

	async list(cwd?: string | undefined): Promise<SessionMapRecord[]> {
		const records = [...(await this.load()).values()];
		const filtered = cwd ? records.filter((r) => r.cwd === cwd) : records;
		filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
		return filtered;
	}

	async get(sessionId: string): Promise<SessionMapRecord | undefined> {
		return (await this.load()).get(sessionId);
	}

	async put(record: SessionMapRecord): Promise<void> {
		const map = await this.load();
		map.set(record.sessionId, record);
		await this.persist();
	}

	async delete(sessionId: string): Promise<void> {
		const map = await this.load();
		if (map.delete(sessionId)) await this.persist();
	}

	/** Update `updatedAt` (and optionally `title`) without touching the rest. */
	async touch(sessionId: string, title?: string | undefined): Promise<void> {
		const record = (await this.load()).get(sessionId);
		if (!record) return;
		const next: SessionMapRecord = { ...record, updatedAt: new Date().toISOString() };
		if (title !== undefined) next.title = title;
		await this.put(next);
	}

	private async load(): Promise<Map<string, SessionMapRecord>> {
		if (this.cache) return this.cache;
		const map = new Map<string, SessionMapRecord>();
		if (await fileExists(this.filePath)) {
			try {
				const parsed = JSON.parse(await readFile(this.filePath, "utf8")) as SessionMapFile;
				if (parsed.version !== FORMAT_VERSION) {
					throw new Error(`unsupported session map version ${String(parsed.version)}`);
				}
				for (const record of parsed.sessions ?? []) {
					if (typeof record.sessionId === "string" && typeof record.piSessionPath === "string") {
						map.set(record.sessionId, record);
					}
				}
			} catch (error) {
				// A corrupt map must not break the adapter; start empty rather
				// than crash, but keep the old file untouched for inspection.
				this.logger.warn(`failed to parse session map ${this.filePath}: ${String(error)}`);
			}
		}
		this.cache = map;
		return map;
	}

	private async persist(): Promise<void> {
		const records = [...(this.cache ?? new Map<string, SessionMapRecord>()).values()];
		const payload: SessionMapFile = { version: FORMAT_VERSION, sessions: records };
		await mkdir(dirname(this.filePath), { recursive: true });
		// Atomic write: a torn file would lose all session mappings.
		const tmpPath = join(dirname(this.filePath), `.${(Math.random() * 1e9).toFixed(0)}.tmp`);
		await writeFile(tmpPath, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
		await rename(tmpPath, this.filePath);
	}
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
