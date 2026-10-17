import { createHash } from "node:crypto";
import { open, readdir, stat, type FileHandle } from "node:fs/promises";
import { join } from "node:path";

/**
 * Incremental parser over append-only JSONL. `line` may mutate `state`;
 * `clone` must return an independent copy because an unterminated trailing
 * line is parsed speculatively on a clone and never committed.
 */
export type JsonlParser<S, R> = {
	initial(path: string): S;
	clone(state: S): S;
	line(state: S, value: unknown, emit: (record: R) => void): void;
};

export type JsonlFileResult<R> = { readonly path: string; readonly records: readonly R[] };
export type JsonlSkippedFile = { readonly path: string; readonly error: string };
export type JsonlReadResult<R> = {
	readonly files: JsonlFileResult<R>[];
	readonly skipped: JsonlSkippedFile[];
	readonly malformedLines: number;
};

type CacheEntry<S, R> = {
	readonly ino: number;
	readonly size: number;
	readonly mtimeMs: number;
	/** Byte offset just after the last committed newline. */
	readonly offset: number;
	/** Hash of the bytes right before `offset`; detects in-place rewrites. */
	readonly anchor: string;
	readonly state: S;
	readonly committed: readonly R[];
	/** `committed` plus the speculative unterminated tail, if any. */
	readonly view: readonly R[];
	readonly malformedLines: number;
};

const CHUNK_BYTES = 256 * 1024;
const ANCHOR_BYTES = 64;
const FILES_PER_YIELD = 16;

/**
 * Per-file cache keyed by path and inode. Unchanged files are reused, grown
 * files parse only appended bytes, and truncated/replaced/rewritten files are
 * rescanned. Reads are serialized so concurrent callers never interleave
 * commits; an aborted read leaves previously committed entries intact.
 */
export class JsonlTailCache<S, R> {
	private readonly entries = new Map<string, CacheEntry<S, R>>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly parser: JsonlParser<S, R>) {}

	/** `prune: false` keeps cache entries for paths outside `paths` (partial reads). */
	read(paths: readonly string[], signal?: AbortSignal, options: { prune?: boolean } = {}): Promise<JsonlReadResult<R>> {
		const run = this.queue.then(() => this.readNow(paths, signal, options.prune !== false));
		this.queue = run.catch(() => undefined);
		return run;
	}

	clear(): void {
		this.entries.clear();
	}

	private async readNow(paths: readonly string[], signal: AbortSignal | undefined, prune: boolean): Promise<JsonlReadResult<R>> {
		const wanted = new Set(paths);
		if (prune) for (const path of [...this.entries.keys()]) if (!wanted.has(path)) this.entries.delete(path);
		const files: JsonlFileResult<R>[] = [];
		const skipped: JsonlSkippedFile[] = [];
		let malformedLines = 0;
		let processed = 0;
		for (const path of [...wanted].sort()) {
			signal?.throwIfAborted();
			try {
				const entry = await this.refresh(path, signal);
				if (entry) {
					files.push({ path, records: entry.view });
					malformedLines += entry.malformedLines;
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				this.entries.delete(path);
				skipped.push({ path, error: errorCode(error) });
			}
			if (++processed % FILES_PER_YIELD === 0) await yieldToEventLoop();
		}
		return { files, skipped, malformedLines };
	}

	private async refresh(path: string, signal: AbortSignal | undefined): Promise<CacheEntry<S, R> | undefined> {
		let info: Awaited<ReturnType<typeof stat>>;
		try {
			info = await stat(path);
		} catch (error) {
			if (isMissing(error)) {
				this.entries.delete(path);
				return undefined;
			}
			throw error;
		}
		const cached = this.entries.get(path);
		if (cached && cached.ino === info.ino && cached.size === info.size && cached.mtimeMs === info.mtimeMs) return cached;

		const handle = await open(path, "r");
		try {
			const size = Number(info.size);
			const base = cached && cached.ino === Number(info.ino) && size >= cached.offset
				&& await anchorAt(handle, cached.offset) === cached.anchor
				? cached
				: undefined;
			const state = base ? this.parser.clone(base.state) : this.parser.initial(path);
			const added: R[] = [];
			const emit = (record: R) => { added.push(record); };
			let malformedLines = base?.malformedLines ?? 0;
			let position = base?.offset ?? 0;
			let pending: Buffer = Buffer.alloc(0);
			const buffer = Buffer.allocUnsafe(CHUNK_BYTES);

			while (position < size) {
				signal?.throwIfAborted();
				const { bytesRead } = await handle.read(buffer, 0, Math.min(CHUNK_BYTES, size - position), position);
				if (bytesRead === 0) break;
				position += bytesRead;
				const chunk = pending.length > 0 ? Buffer.concat([pending, buffer.subarray(0, bytesRead)]) : buffer.subarray(0, bytesRead);
				let start = 0;
				for (let newline = chunk.indexOf(10, start); newline !== -1; newline = chunk.indexOf(10, start)) {
					if (!this.parseLine(chunk.subarray(start, newline), state, emit)) malformedLines += 1;
					start = newline + 1;
				}
				pending = Buffer.from(chunk.subarray(start));
			}
			signal?.throwIfAborted();

			const offset = position - pending.length;
			const committed = base ? base.committed.concat(added) : added;
			const tentative: R[] = [];
			if (pending.length > 0) this.parseLine(pending, this.parser.clone(state), (record) => { tentative.push(record); });
			const entry: CacheEntry<S, R> = {
				ino: Number(info.ino),
				size,
				mtimeMs: info.mtimeMs,
				offset,
				anchor: await anchorAt(handle, offset),
				state,
				committed,
				view: tentative.length > 0 ? committed.concat(tentative) : committed,
				malformedLines,
			};
			this.entries.set(path, entry);
			return entry;
		} finally {
			await handle.close();
		}
	}

	/** Returns `false` only for non-empty lines that are not valid JSON. */
	private parseLine(bytes: Buffer, state: S, emit: (record: R) => void): boolean {
		const text = bytes.toString("utf8").trim();
		if (!text) return true;
		let value: unknown;
		try {
			value = JSON.parse(text);
		} catch {
			return false;
		}
		this.parser.line(state, value, emit);
		return true;
	}
}

/** Sorted `.jsonl` files below `root`; `undefined` when the root does not exist. */
export async function listJsonlFiles(root: string): Promise<string[] | undefined> {
	let entries;
	try {
		entries = await readdir(root, { recursive: true, withFileTypes: true });
	} catch (error) {
		if (isMissing(error) || (error as NodeJS.ErrnoException).code === "ENOTDIR") return undefined;
		throw error;
	}
	return entries
		.filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
		.map((entry) => join(entry.parentPath, entry.name))
		.sort();
}

async function anchorAt(handle: FileHandle, offset: number): Promise<string> {
	if (offset <= 0) return "";
	const length = Math.min(ANCHOR_BYTES, offset);
	const bytes = Buffer.alloc(length);
	const { bytesRead } = await handle.read(bytes, 0, length, offset - length);
	return createHash("sha1").update(bytes.subarray(0, bytesRead)).digest("hex");
}

function isMissing(error: unknown): boolean {
	return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function errorCode(error: unknown): string {
	const code = (error as NodeJS.ErrnoException | undefined)?.code;
	if (typeof code === "string") return code;
	return error instanceof Error ? error.name : "Error";
}

function yieldToEventLoop(): Promise<void> {
	return new Promise((resolve) => { setImmediate(resolve); });
}
