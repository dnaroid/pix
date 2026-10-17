import assert from "node:assert/strict";
import { appendFile, mkdtemp, rename, rm, truncate, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { JsonlTailCache, listJsonlFiles, type JsonlParser } from "../src/app/usage-stats/jsonl-tail-cache.js";

type Row = { n: number; v: unknown };

function countingParser(): { parser: JsonlParser<{ count: number }, Row>; calls: () => number } {
	let calls = 0;
	return {
		parser: {
			initial: () => ({ count: 0 }),
			clone: (state) => ({ ...state }),
			line(state, value, emit) {
				calls += 1;
				emit({ n: state.count++, v: (value as { v?: unknown }).v });
			},
		},
		calls: () => calls,
	};
}

const line = (v: unknown) => `${JSON.stringify({ v })}\n`;
const values = (rows: readonly Row[] | undefined) => (rows ?? []).map((row) => row.v);

describe("JsonlTailCache", () => {
	let dir: string;
	beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "pix-usage-tail-")); });
	afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

	it("parses complete lines, counts malformed ones and shows an unterminated tail speculatively", async () => {
		const file = join(dir, "a.jsonl");
		await writeFile(file, `${line(1)}not json\n\n${line(2)}{"v":3}`);
		const { parser } = countingParser();
		const cache = new JsonlTailCache(parser);
		const result = await cache.read([file]);
		assert.deepEqual(values(result.files[0]?.records), [1, 2, 3]);
		assert.equal(result.malformedLines, 1);

		// Completing the tail must not duplicate the speculative record.
		await appendFile(file, `\n${line(4)}`);
		const next = await cache.read([file]);
		assert.deepEqual(values(next.files[0]?.records), [1, 2, 3, 4]);
		assert.deepEqual(next.files[0]?.records.map((row) => row.n), [0, 1, 2, 3]);
	});

	it("reuses unchanged files and parses only appended bytes", async () => {
		const file = join(dir, "a.jsonl");
		await writeFile(file, line(1) + line(2));
		const { parser, calls } = countingParser();
		const cache = new JsonlTailCache(parser);
		await cache.read([file]);
		assert.equal(calls(), 2);
		await cache.read([file]);
		assert.equal(calls(), 2);
		await appendFile(file, line(3));
		const result = await cache.read([file]);
		assert.equal(calls(), 3);
		assert.deepEqual(values(result.files[0]?.records), [1, 2, 3]);
	});

	it("rescans truncated, replaced and rewritten files", async () => {
		const file = join(dir, "a.jsonl");
		await writeFile(file, line("aa") + line("bb"));
		const { parser } = countingParser();
		const cache = new JsonlTailCache(parser);
		await cache.read([file]);

		await truncate(file, line("aa").length);
		assert.deepEqual(values((await cache.read([file])).files[0]?.records), ["aa"]);

		const replacement = join(dir, "replacement.tmp");
		await writeFile(replacement, line("cc") + line("dd") + line("ee"));
		await rename(replacement, file);
		assert.deepEqual(values((await cache.read([file])).files[0]?.records), ["cc", "dd", "ee"]);

		// Same size, different content and mtime: the anchor detects the rewrite.
		await writeFile(file, line("cc") + line("dd") + line("zz"));
		const later = new Date(Date.now() + 60_000);
		await utimes(file, later, later);
		assert.deepEqual(values((await cache.read([file])).files[0]?.records), ["cc", "dd", "zz"]);
	});

	it("drops deleted and unrequested files", async () => {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		await writeFile(a, line(1));
		await writeFile(b, line(2));
		const { parser, calls } = countingParser();
		const cache = new JsonlTailCache(parser);
		assert.equal((await cache.read([b, a])).files.map((file) => file.path).join(), [a, b].join());
		await rm(a);
		const result = await cache.read([a, b]);
		assert.deepEqual(result.files.map((file) => file.path), [b]);
		assert.deepEqual(result.skipped, []);
		await cache.read([]);
		await cache.read([b]);
		assert.equal(calls(), 3, "an unrequested entry is evicted and reparsed later");
	});

	it("keeps unrequested entries when prune is disabled", async () => {
		const a = join(dir, "a.jsonl");
		const b = join(dir, "b.jsonl");
		await writeFile(a, '{"v":1}\n');
		await writeFile(b, '{"v":2}\n');
		const parses: string[] = [];
		const cache = new JsonlTailCache<{ count: number }, unknown>({
			initial: (path) => { parses.push(path); return { count: 0 }; },
			clone: (state) => ({ ...state }),
			line: (_state, value, emit) => emit(value),
		});
		await cache.read([a, b]);
		await cache.read([a], undefined, { prune: false });
		await cache.read([a, b]);
		assert.deepEqual(parses, [a, b], "b stayed cached across the partial read");
	});

	it("keeps committed entries intact when a read is aborted", async () => {
		const file = join(dir, "a.jsonl");
		await writeFile(file, line(1));
		const { parser } = countingParser();
		const cache = new JsonlTailCache(parser);
		await cache.read([file]);
		await appendFile(file, line(2));
		const controller = new AbortController();
		controller.abort();
		await assert.rejects(cache.read([file], controller.signal));
		assert.deepEqual(values((await cache.read([file])).files[0]?.records), [1, 2]);
	});

	it("serializes concurrent reads", async () => {
		const file = join(dir, "a.jsonl");
		await writeFile(file, line(1) + line(2));
		const { parser, calls } = countingParser();
		const cache = new JsonlTailCache(parser);
		const [first, second] = await Promise.all([cache.read([file]), cache.read([file])]);
		assert.deepEqual(values(first.files[0]?.records), [1, 2]);
		assert.deepEqual(values(second.files[0]?.records), [1, 2]);
		assert.equal(calls(), 2);
	});

	it("lists nested jsonl files and reports a missing root as undefined", async () => {
		await writeFile(join(dir, "b.jsonl"), "");
		await mkdirp(join(dir, "nested", "deep"));
		await writeFile(join(dir, "nested", "deep", "a.jsonl"), "");
		await writeFile(join(dir, "nested", "skip.json"), "");
		assert.deepEqual(await listJsonlFiles(dir), [join(dir, "b.jsonl"), join(dir, "nested", "deep", "a.jsonl")].sort());
		assert.equal(await listJsonlFiles(join(dir, "missing")), undefined);
	});
});

async function mkdirp(path: string): Promise<void> {
	const { mkdir } = await import("node:fs/promises");
	await mkdir(path, { recursive: true });
}
