import { createHash } from "node:crypto";
import { PROJECT_CACHE_MAX_AGE_MS, PROJECT_CACHE_MAX_ENTRIES, createProjectJsonCache } from "./project-json-cache.js";

/**
 * Durable per-project cache of translated Markdown chunks under
 * `<project>/.pi/translations/`. Entries are keyed by target language and the
 * exact source chunk, so any edit to a chunk is a cache miss (the stale entry
 * is never reused and ages out), while unchanged chunks of an edited document
 * are reused. Retention: see `project-json-cache.ts` (30 days unused, 4,000 entries).
 */
export const TRANSLATION_CACHE_DIRECTORY = ".pi/translations";
export const TRANSLATION_CACHE_MAX_AGE_MS = PROJECT_CACHE_MAX_AGE_MS;
export const TRANSLATION_CACHE_MAX_ENTRIES = PROJECT_CACHE_MAX_ENTRIES;
const TRANSLATION_CACHE_VERSION = 1;

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
	const now = options.now ?? Date.now;
	const store = createProjectJsonCache({ directory: TRANSLATION_CACHE_DIRECTORY, ...options });
	return {
		async get(cwd, language, source) {
			const key = translationCacheKey(language, source);
			const entry = await store.read(cwd, key);
			return isEntry(entry) && entry.language === language && entry.sourceHash === key ? entry.translation : undefined;
		},
		async set(cwd, language, source, translation) {
			const key = translationCacheKey(language, source);
			const entry: CacheEntry = { version: TRANSLATION_CACHE_VERSION, language, sourceHash: key, createdAt: new Date(now()).toISOString(), translation };
			await store.write(cwd, key, entry);
		},
		prune: store.prune,
	};
}

function isEntry(value: unknown): value is CacheEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return entry.version === TRANSLATION_CACHE_VERSION
		&& typeof entry.language === "string"
		&& typeof entry.sourceHash === "string"
		&& typeof entry.translation === "string";
}
