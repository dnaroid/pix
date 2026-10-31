import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistModelRequest } from "../src/acp/assist-model-runner.js";
import { parseDesktopFileAnnotateRequest } from "../src/acp/desktop-commands.js";
import {
	EXPLANATION_CACHE_DIRECTORY, createFileAnnotator, splitFileIntoParts, type FileAnnotationProgress,
} from "../src/acp/file-annotation.js";

const project = () => mkdtempSync(join(tmpdir(), "pix-file-annotation-"));
const signal = () => new AbortController().signal;
const config = (language = "ru") => () => ({ modelRefs: ["p/m"], language });

/** A source with a top-level function every 50 lines. */
function source(lines: number, marker = ""): string {
	return Array.from({ length: lines }, (_, index) => index % 50 === 0 ? `function f${index}${marker}() {` : index % 50 === 49 ? "}" : `  step(${index});`).join("\n");
}

const partRange = (prompt: string) => {
	const match = /Part: lines (\d+)–(\d+)/u.exec(prompt);
	return match ? { first: Number(match[1]), last: Number(match[2]) } : undefined;
};

/** Answers summaries with text and each part with one note on its first line. */
function fakeRunner(options: { failPart?: number; delay?: () => Promise<void> } = {}) {
	const requests: AssistModelRequest[] = [];
	let active = 0;
	let maxActive = 0;
	const run = async (request: AssistModelRequest) => {
		requests.push(request);
		active += 1;
		maxActive = Math.max(maxActive, active);
		try {
			await (options.delay?.() ?? Promise.resolve());
			const range = partRange(request.prompt);
			if (!range && /summarize/u.test(request.systemPrompt)) return "Модуль считает шаги.";
			if (!range) return '{"summary": "Small file.", "notes": [{"line": 1, "text": "Entry."}]}';
			if (range.first === options.failPart) throw new Error("model down");
			return `{"notes": [{"line": ${range.first}, "text": "Part at ${range.first}."}]}`;
		} finally {
			active -= 1;
		}
	};
	return { run, requests, get maxActive() { return maxActive; } };
}

test("files split at top-level boundaries into bounded parts with no tiny tail", () => {
	const lines = source(1_000).split("\n");
	const parts = splitFileIntoParts(lines);
	assert.deepEqual(parts.map((part) => [part.firstLine, part.lastLine]), [[1, 300], [301, 600], [601, 900], [901, 1000]]);
	assert.ok(parts.every((part, index) => index === 0 || /^function/u.test(part.lines[0]!)));
	assert.equal(parts.reduce((sum, part) => sum + part.lines.length, 0), 1_000);
	const flat = Array.from({ length: 1_000 }, (_, index) => `    deep(${index});`);
	assert.deepEqual(splitFileIntoParts(flat).map((part) => part.lines.length), [450, 450, 100], "hard cut at 450 without a boundary");
	assert.equal(splitFileIntoParts(source(330).split("\n")).length, 1, "a small trailing part merges into the previous one");
});

test("a small file is one call returning the summary and notes", async () => {
	const runner = fakeRunner();
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: config() });
	const progress: FileAnnotationProgress[] = [];
	const result = await explain({ cwd: project(), path: "src/a.ts", text: "let a = 0;\r\nfunction f() {}\n", signal: signal(), onProgress: (update) => { progress.push(update); } });
	assert.deepEqual(result, {
		summary: "Small file.", annotations: [{ line: 1, text: "Entry." }], language: "ru",
		annotatedLines: 3, totalLines: 3, parts: 1, failedParts: 0, cached: false,
	});
	assert.equal(runner.requests.length, 1);
	assert.match(runner.requests[0]!.prompt, /^File: src\/a\.ts\n<file>\n1\| let a = 0;\n2\| function f\(\) \{\}\n3\| \n<\/file>$/u);
	assert.deepEqual(progress, [{ summary: "Small file.", annotations: [{ line: 1, text: "Entry." }], completedParts: 1, totalParts: 1 }]);
});

test("a large file is explained in parallel parts plus a summary, with bounded concurrency and progress", async () => {
	const runner = fakeRunner({ delay: () => new Promise((resolve) => setTimeout(resolve, 5)) });
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: config(), concurrency: 2 });
	const progress: FileAnnotationProgress[] = [];
	const result = await explain({ cwd: project(), path: "src/big.ts", text: source(1_500), signal: signal(), onProgress: (update) => { progress.push(update); } });
	assert.equal(result.parts, 5);
	assert.equal(result.failedParts, 0);
	assert.equal(result.summary, "Модуль считает шаги.");
	assert.deepEqual(result.annotations.map((note) => note.line), [1, 301, 601, 901, 1201]);
	assert.equal(runner.requests.length, 6, "five parts and one summary");
	assert.ok(runner.maxActive <= 3, "two parts plus the summary at most");
	assert.ok(runner.requests.filter((request) => partRange(request.prompt)).every((request) => /<part>\n\s*\d+\| /u.test(request.prompt)));
	assert.equal(progress.filter((update) => update.annotations).length, 5);
	assert.equal(progress.find((update) => update.summary)?.summary, "Модуль считает шаги.");
	assert.deepEqual(progress.filter((update) => update.annotations).map((update) => update.completedParts), [1, 2, 3, 4, 5]);
	assert.ok(progress.every((update) => update.totalParts === 5));
});

test("cached parts are reused after an edit elsewhere, even when their lines moved", async () => {
	const cwd = project();
	const first = fakeRunner();
	await createFileAnnotator({ runner: first.run, loadConfig: config() })({ cwd, path: "src/big.ts", text: source(1_000), signal: signal() });
	assert.equal((await createFileAnnotator({ runner: first.run, loadConfig: config() })({ cwd, path: "src/big.ts", text: source(1_000), signal: signal() })).cached, true);
	assert.equal(first.requests.length, 5, "four parts and a summary; the unchanged file is then served whole from the cache");

	const second = fakeRunner();
	const edited = `// header added\n${source(1_000)}`;
	const result = await createFileAnnotator({ runner: second.run, loadConfig: config() })({ cwd, path: "src/big.ts", text: edited, signal: signal() });
	assert.equal(result.cached, false, "an edit invalidates the whole-file entry");
	// The header line joins part one; parts two to four keep their text and shift down by one line.
	assert.deepEqual(second.requests.map((request) => partRange(request.prompt)?.first).filter(Boolean), [1], "only the changed part is asked again");
	assert.deepEqual(result.annotations.map((note) => note.line), [1, 302, 602, 902]);

	const third = fakeRunner();
	const shifted = await createFileAnnotator({ runner: third.run, loadConfig: config() })({ cwd, path: "src/other.ts", text: source(1_000), signal: signal() });
	assert.equal(third.requests.filter((request) => partRange(request.prompt)).length, 0, "identical part text hits the part cache from any file");
	assert.deepEqual(shifted.annotations.map((note) => note.line), [1, 301, 601, 901]);
});

test("a failed part keeps the other notes, is not cached as a whole and is retried next time", async () => {
	const cwd = project();
	const failing = fakeRunner({ failPart: 301 });
	const partial = await createFileAnnotator({ runner: failing.run, loadConfig: config() })({ cwd, path: "src/big.ts", text: source(1_000), signal: signal() });
	assert.equal(partial.failedParts, 1);
	assert.deepEqual(partial.annotations.map((note) => note.line), [1, 601, 901]);

	const healthy = fakeRunner();
	const retried = await createFileAnnotator({ runner: healthy.run, loadConfig: config() })({ cwd, path: "src/big.ts", text: source(1_000), signal: signal() });
	assert.equal(retried.cached, false);
	assert.deepEqual(healthy.requests.map((request) => partRange(request.prompt)?.first).filter(Boolean), [301], "only the failed part is asked again");
	assert.deepEqual(retried.annotations.map((note) => note.line), [1, 301, 601, 901]);
});

test("another language misses every cache and refresh bypasses them", async () => {
	const cwd = project();
	const runner = fakeRunner();
	let language = "ru";
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: () => ({ modelRefs: ["p/m"], language }) });
	await explain({ cwd, path: "src/big.ts", text: source(1_000), signal: signal() });
	language = "en";
	await explain({ cwd, path: "src/big.ts", text: source(1_000), signal: signal() });
	assert.equal(runner.requests.length, 10);
	await explain({ cwd, path: "src/big.ts", text: source(1_000), refresh: true, signal: signal() });
	assert.equal(runner.requests.length, 15);
	assert.equal((await readdir(join(cwd, EXPLANATION_CACHE_DIRECTORY))).filter((name) => name.endsWith(".json")).length, 9, "eight part entries and one file entry");
});

test("cancellation aborts the whole explanation", async () => {
	const controller = new AbortController();
	const runner = fakeRunner({ delay: async () => { controller.abort(new Error("cancelled")); } });
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: config() });
	await assert.rejects(explain({ cwd: project(), path: "src/big.ts", text: source(1_000), signal: controller.signal }), /cancelled/u);
});

test("an unusable single answer is reported with a bounded excerpt and a clear message", async () => {
	const excerpts: string[] = [];
	const explain = createFileAnnotator({
		runner: async () => `I cannot do that. ${"x".repeat(1_000)}`,
		loadConfig: config("en"),
		onUnusableAnswer: (excerpt) => { excerpts.push(excerpt); },
	});
	const cwd = project();
	await assert.rejects(explain({ cwd, text: "a\n", signal: signal() }), /could not be read as an explanation\.$/u);
	assert.equal(excerpts[0]!.length, 600);
	await assert.rejects(readdir(join(cwd, EXPLANATION_CACHE_DIRECTORY)));
});

test("file annotate request parser", () => {
	assert.deepEqual(parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", path: "a.ts", refresh: true, requestId: "r" }), { cwd: "/w", text: "x", path: "a.ts", refresh: true, requestId: "r" });
	assert.deepEqual(parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", refresh: false }), { cwd: "/w", text: "x" });
	assert.throws(() => parseDesktopFileAnnotateRequest({ cwd: "/w", text: "  " }));
	assert.throws(() => parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", refresh: 1 }));
});
