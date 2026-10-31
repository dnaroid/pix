import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Durable per-project cache of translated Markdown chunks under
 * `<project>/.pi/translations/`. Entries are keyed by target language and the
 * exact source chunk, so re-opening or re-translating an edited document only
 * sends changed chunks to a model. Retention: entries unused for
 * `maxAgeMs` are pruned, and at most `maxEntries` most recently used remain.
 */
export const TRANSLATION_CACHE_DIRECTORY = ".pi/translations";
export const TRANSLATION_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const TRANSLATION_CACHE_MAX_ENTRIES = 4_000;
const TRANSLATION_CACHE_VERSION = 1;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;
const STALE_TEMP_AGE_MS = 24 * 60 * 60 * 1000;
const ENTRY_PATTERN = /^[0-9a-f]{64}\.json$/u;

export interface TranslationCacheOptions {
	readonly maxAgeMs?: number;
	readonly maxEntries?: number;
	readonly now?: () => number;
}

export interface TranslationCache {
	get(cwd: string, language: string, source: string): Promise<string | undefined>;
	set(cwd: string, language: string, source: string, translation: string): Promise<void>;
	/** Applies the retention policy; throttled per project unless `force`. */
	prune(cwd: string, force?: boolean): Promise<number>;
}

interface CacheEntry {
	readonly version: number;
	readonly language: string;
	readonly sourceHash: string;
	readonly createdAt: string;
	readonly translation: string;
}

export function translationCacheKey(language: string, source: string): string {
	return createHash("sha256").update(JSON.stringify([TRANSLATION_CACHE_VERSION, language, source])).digest("hex");
}

export function createTranslationCache(options: TranslationCacheOptions = {}): TranslationCache {
	const maxAgeMs = options.maxAgeMs ?? TRANSLATION_CACHE_MAX_AGE_MS;
	const maxEntries = options.maxEntries ?? TRANSLATION_CACHE_MAX_ENTRIES;
	const now = options.now ?? Date.now;
	const lastPrune = new Map<string, number>();
	const pruning = new Map<string, Promise<number>>();
	const directory = (cwd: string) => join(cwd, TRANSLATION_CACHE_DIRECTORY);

	async function get(cwd: string, language: string, source: string): Promise<string | undefined> {
		const key = translationCacheKey(language, source);
		const path = join(directory(cwd), `${key}.json`);
		let entry: unknown;
		try {
			entry = JSON.parse(await readFile(path, "utf8"));
		} catch {
			return undefined;
		}
		if (!isEntry(entry) || entry.language !== language || entry.sourceHash !== key) return undefined;
		const time = new Date(now());
		// Touch marks the entry as recently used for retention; failure only shortens its life.
		await utimes(path, time, time).catch(() => {});
		return entry.translation;
	}

	async function set(cwd: string, language: string, source: string, translation: string): Promise<void> {
		const key = translationCacheKey(language, source);
		const dir = directory(cwd);
		await mkdir(dir, { recursive: true });
		const entry: CacheEntry = { version: TRANSLATION_CACHE_VERSION, language, sourceHash: key, createdAt: new Date(now()).toISOString(), translation };
		const temp = join(dir, `.${key}.${randomUUID()}.tmp`);
		try {
			await writeFile(temp, `${JSON.stringify(entry)}\n`, "utf8");
			await rename(temp, join(dir, `${key}.json`));
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
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
		const remove: string[] = [];
		for (const name of names) {
			const path = join(dir, name);
			const info = await stat(path).catch(() => undefined);
			if (!info?.isFile()) continue;
			if (name.endsWith(".tmp")) {
				if (current - info.mtimeMs >= STALE_TEMP_AGE_MS) remove.push(path);
				continue;
			}
			if (!ENTRY_PATTERN.test(name)) continue;
			if (current - info.mtimeMs >= maxAgeMs) remove.push(path);
			else entries.push({ path, used: info.mtimeMs });
		}
		if (entries.length > maxEntries) {
			entries.sort((left, right) => right.used - left.used);
			remove.push(...entries.slice(maxEntries).map((entry) => entry.path));
		}
		let removed = 0;
		for (const path of remove) {
			try {
				await rm(path, { force: true });
				removed += 1;
			} catch {
				// A concurrent writer may have replaced it; the next prune retries.
			}
		}
		return removed;
	}

	return { get, set, prune };
}

function isEntry(value: unknown): value is CacheEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return entry.version === TRANSLATION_CACHE_VERSION
		&& typeof entry.language === "string"
		&& typeof entry.sourceHash === "string"
		&& typeof entry.translation === "string";
}
