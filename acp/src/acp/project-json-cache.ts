import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable per-project JSON cache: one `<sha256>.json` file per entry under a
 * `.pi/<name>/` directory. A hit refreshes the entry's mtime (last use);
 * pruning removes entries unused for `maxAgeMs`, keeps at most `maxEntries`
 * most recently used and drops stale temporary files. Writes are atomic
 * (temp file + rename). Callers validate content and decide staleness.
 */
export const PROJECT_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const PROJECT_CACHE_MAX_ENTRIES = 4_000;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const ENTRY_PATTERN = /^[0-9a-f]{64}\.json$/u;
const KEY_PATTERN = /^[0-9a-f]{64}$/u;

export interface ProjectJsonCacheOptions {
	/** Project-relative directory, e.g. `.pi/translations`. */
	readonly directory: string;
	readonly maxAgeMs?: number;
	readonly maxEntries?: number;
	readonly now?: () => number;
}

export interface ProjectJsonCache {
	read(cwd: string, key: string): Promise<unknown>;
	write(cwd: string, key: string, value: unknown): Promise<void>;
	remove(cwd: string, key: string): Promise<void>;
	/** Applies the retention policy; throttled per project unless `force`. */
	prune(cwd: string, force?: boolean): Promise<number>;
}

export function createProjectJsonCache(options: ProjectJsonCacheOptions): ProjectJsonCache {
	const maxAgeMs = options.maxAgeMs ?? PROJECT_CACHE_MAX_AGE_MS;
	const maxEntries = options.maxEntries ?? PROJECT_CACHE_MAX_ENTRIES;
	const now = options.now ?? Date.now;
	const lastPrune = new Map<string, number>();
	const pruning = new Map<string, Promise<number>>();
	const directory = (cwd: string) => join(cwd, options.directory);
	const entryPath = (cwd: string, key: string) => {
		if (!KEY_PATTERN.test(key)) throw new Error("Invalid project cache key");
		return join(directory(cwd), `${key}.json`);
	};

	async function read(cwd: string, key: string): Promise<unknown> {
		const path = entryPath(cwd, key);
		let value: unknown;
		try {
			value = JSON.parse(await readFile(path, "utf8"));
		} catch {
			return undefined;
		}
		const time = new Date(now());
		// Touch marks the entry as recently used for retention; failure only shortens its life.
		await utimes(path, time, time).catch(() => {});
		return value;
	}

	async function write(cwd: string, key: string, value: unknown): Promise<void> {
		const path = entryPath(cwd, key);
		const dir = directory(cwd);
		await mkdir(dir, { recursive: true });
		const temp = join(dir, `.${key}.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, `${JSON.stringify(value)}\n`, "utf8");
			await rename(temp, path);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
	}

	async function remove(cwd: string, key: string): Promise<void> {
		await rm(entryPath(cwd, key), { force: true });
	}

	function prune(cwd: string, force = false): Promise<number> {
		const dir = directory(cwd);
		const running = pruning.get(dir);
		if (running) return running;
		if (!force && now() - (lastPrune.get(dir) ?? -Infinity) < PRUNE_INTERVAL_MS) return Promise.resolve(0);
		lastPrune.set(dir, now());
		const task = pruneDirectory(dir).finally(() => pruning.delete(dir));
		pruning.set(dir, task);
		return task;
	}

	async function pruneDirectory(dir: string): Promise<number> {
		let names: string[];
		try {
			names = await readdir(dir);
		} catch {
			return 0;
		}
		const current = now();
		const entries: { path: string; used: number }[] = [];
		const stale: string[] = [];
		for (const name of names) {
			const path = join(dir, name);
			const info = await stat(path).catch(() => undefined);
			if (!info?.isFile()) continue;
			if (name.endsWith(".tmp")) {
				if (current - info.mtimeMs >= STALE_TEMP_AGE_MS) stale.push(path);
				continue;
			}
			if (!ENTRY_PATTERN.test(name)) continue;
			if (current - info.mtimeMs >= maxAgeMs) stale.push(path);
			else entries.push({ path, used: info.mtimeMs });
		}
		if (entries.length > maxEntries) {
			entries.sort((left, right) => right.used - left.used);
			stale.push(...entries.slice(maxEntries).map((entry) => entry.path));
		}
		let removed = 0;
		for (const path of stale) {
			try {
				await rm(path, { force: true });
				removed += 1;
			} catch {
				// A concurrent writer may have replaced it; the next prune retries.
			}
		}
		return removed;
	}

	return { read, write, remove, prune };
}
