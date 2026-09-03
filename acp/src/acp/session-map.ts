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

import { createHash } from "node:crypto";
import { access, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { lock } from "proper-lockfile";
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
	/** Records for the currently serialized operation. */
	private cache: Map<string, SessionMapRecord> | null = null;
	/** Serializes reads and mutations within this adapter process. */
	private operationQueue: Promise<void> = Promise.resolve();

	constructor(filePath: string, logger: Logger) {
		this.filePath = filePath;
		this.logger = logger;
	}

	async list(cwd?: string | undefined): Promise<SessionMapRecord[]> {
		return this.inspect((map) => {
			const records = [...map.values()];
			const filtered = cwd ? records.filter((r) => r.cwd === cwd) : records;
			filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
			return filtered;
		});
	}

	async get(sessionId: string): Promise<SessionMapRecord | undefined> {
		return this.inspect((map) => map.get(sessionId));
	}

	async put(record: SessionMapRecord): Promise<void> {
		await this.mutate(async () => {
			const map = this.requireCache();
			const piSessionPath = resolve(record.piSessionPath);
			for (const existing of map.values()) {
				if (existing.sessionId !== record.sessionId && resolve(existing.piSessionPath) === piSessionPath) {
					map.delete(existing.sessionId);
				}
			}
			map.set(record.sessionId, { ...record, piSessionPath });
			await this.persist();
		});
	}

	/**
	 * Merge sessions discovered from Pi's native JSONL store in one locked write.
	 * Existing ACP ids win when a Pi session path is already known.
	 */
	async mergeByPiSessionPath(records: readonly SessionMapRecord[]): Promise<void> {
		if (records.length === 0) return;
		await this.mutate(async () => {
			const map = this.requireCache();
			const byPath = new Map<string, SessionMapRecord[]>();
			for (const record of map.values()) {
				const path = resolve(record.piSessionPath);
				byPath.set(path, [...(byPath.get(path) ?? []), record]);
			}
			let changed = false;

			for (const candidate of records) {
				const piSessionPath = resolve(candidate.piSessionPath);
				const matches = byPath.get(piSessionPath) ?? [];
				const existing = matches.find((record) => record.sessionId !== candidate.sessionId) ?? matches[0];
				for (const duplicate of matches) {
					if (duplicate.sessionId !== existing?.sessionId) {
						map.delete(duplicate.sessionId);
						changed = true;
					}
				}
				const sessionId = existing?.sessionId ?? availableSessionId(candidate.sessionId, piSessionPath, map);
				const next: SessionMapRecord = {
					...candidate,
					sessionId,
					piSessionPath,
					...(candidate.title === undefined && existing?.title !== undefined ? { title: existing.title } : {}),
				};
				if (!existing || !sameRecord(existing, next)) {
					map.set(sessionId, next);
					changed = true;
				}
				byPath.set(piSessionPath, [next]);
			}

			if (changed) await this.persist();
		});
	}

	async delete(sessionId: string): Promise<void> {
		await this.mutate(async () => {
			const map = this.requireCache();
			if (map.delete(sessionId)) await this.persist();
		});
	}

	/** Update `updatedAt` (and optionally `title`) without touching the rest. */
	async touch(sessionId: string, title?: string | undefined): Promise<void> {
		await this.mutate(async () => {
			const map = this.requireCache();
			const record = map.get(sessionId);
			if (!record) return;
			const next: SessionMapRecord = { ...record, updatedAt: new Date().toISOString() };
			if (title !== undefined) next.title = title;
			map.set(sessionId, next);
			await this.persist();
		});
	}

	private async readFromDisk(failOnInvalid = false): Promise<Map<string, SessionMapRecord>> {
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
				if (failOnInvalid) {
					throw new Error(`refusing to overwrite invalid session map ${this.filePath}`, { cause: error });
				}
			}
		}
		return map;
	}

	private async inspect<T>(operation: (map: Map<string, SessionMapRecord>) => T): Promise<T> {
		return this.enqueue(async () => {
			this.cache = await this.readFromDisk();
			return operation(this.cache);
		});
	}

	private async mutate(operation: () => Promise<void>): Promise<void> {
		await this.enqueue(async () => {
			const release = await this.acquireFileLock();
			try {
				// Always reload after taking the process-wide lock. Another adapter
				// may have written mappings since this instance last read the file.
				this.cache = await this.readFromDisk(true);
				await operation();
			} finally {
				await release();
			}
		});
	}

	private async enqueue<T>(operation: () => Promise<T>): Promise<T> {
		const queued = this.operationQueue.then(operation, operation);
		this.operationQueue = queued.then(
			() => {},
			() => {},
		);
		return queued;
	}

	private requireCache(): Map<string, SessionMapRecord> {
		if (!this.cache) throw new Error("session map operation has no loaded cache");
		return this.cache;
	}

	private async acquireFileLock(): Promise<() => Promise<void>> {
		await mkdir(dirname(this.filePath), { recursive: true });
		return lock(this.filePath, {
			realpath: false,
			stale: 5_000,
			update: 1_000,
			retries: { retries: 240, factor: 1, minTimeout: 25, maxTimeout: 25, randomize: true },
		});
	}

	private async persist(): Promise<void> {
		const records = [...this.requireCache().values()];
		const payload: SessionMapFile = { version: FORMAT_VERSION, sessions: records };
		await mkdir(dirname(this.filePath), { recursive: true });
		// Atomic write: a torn file would lose all session mappings.
		const tmpPath = join(dirname(this.filePath), `.${(Math.random() * 1e9).toFixed(0)}.tmp`);
		await writeFile(tmpPath, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
		await rename(tmpPath, this.filePath);
	}
}

function availableSessionId(
	preferredId: string,
	piSessionPath: string,
	map: ReadonlyMap<string, SessionMapRecord>,
): string {
	const preferred = map.get(preferredId);
	if (!preferred || resolve(preferred.piSessionPath) === piSessionPath) return preferredId;
	const pathId = `pi-${createHash("sha256").update(piSessionPath).digest("hex").slice(0, 32)}`;
	let candidate = pathId;
	let suffix = 2;
	while (map.has(candidate) && resolve(map.get(candidate)!.piSessionPath) !== piSessionPath) {
		candidate = `${pathId}-${suffix++}`;
	}
	return candidate;
}

function sameRecord(left: SessionMapRecord, right: SessionMapRecord): boolean {
	return left.sessionId === right.sessionId
		&& resolve(left.piSessionPath) === resolve(right.piSessionPath)
		&& left.piSessionId === right.piSessionId
		&& left.cwd === right.cwd
		&& left.title === right.title
		&& left.updatedAt === right.updatedAt;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
