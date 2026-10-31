import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistModelRequest } from "../src/acp/assist-model-runner.js";
import { parseDesktopDocumentTranslateRequest } from "../src/acp/desktop-commands.js";
import { createDocumentTranslator, splitMarkdownForTranslation } from "../src/acp/document-translation.js";
import { TRANSLATION_CACHE_DIRECTORY, createTranslationCache, translationCacheKey } from "../src/acp/translation-cache.js";

const config = () => ({ modelRefs: ["p/m"], language: "ru" });
const project = () => mkdtempSync(join(tmpdir(), "pix-document-translation-"));
const sectionOf = (prompt: string) => /<section>\n([\s\S]*)\n<\/section>/u.exec(prompt)![1]!;

function fakeRunner(transform = (section: string) => section.toUpperCase()) {
	const calls: AssistModelRequest[] = [];
	const run = async (request: AssistModelRequest) => {
		calls.push(request);
		const out = transform(sectionOf(request.prompt));
		await request.onDelta?.({ text: ` ${out.slice(0, 3)}` });
		await request.onDelta?.({ text: `${out.slice(3)}\n` });
		return out;
	};
	return { run, calls };
}

function applyDeltas(deltas: readonly ({ text: string } | { reset: true })[]): string {
	let text = "";
	for (const delta of deltas) text = "reset" in delta ? "" : text + delta.text;
	return text;
}

test("markdown splitter keeps fenced code and front matter verbatim and packs blocks", () => {
	const doc = "---\ntitle: x\n---\n# Title\n\nPara one.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nPara two.\n";
	assert.deepEqual(splitMarkdownForTranslation(doc), [
		{ text: "---\ntitle: x\n---", translate: false },
		{ text: "# Title\n\nPara one.", translate: true },
		{ text: "```ts\nconst a = 1;\n\nconst b = 2;\n```", translate: false },
		{ text: "Para two.", translate: true },
	]);
	const long = splitMarkdownForTranslation(["a".repeat(30), "b".repeat(30), "c".repeat(30)].join("\n\n"), 70);
	assert.deepEqual(long.map((piece) => piece.text.length), [62, 30]);
	assert.ok(splitMarkdownForTranslation(`${"word ".repeat(40)}\n${"word ".repeat(40)}`, 100).every((piece) => piece.text.length <= 100));
});

test("document translation streams progress, caches chunks and reuses them", async () => {
	const cwd = project();
	const doc = "# Title\n\nPara.\n\n```\ncode\n```\n\nTail.";
	const first = fakeRunner();
	const translate = createDocumentTranslator({ runner: first.run, loadConfig: config, cache: createTranslationCache() });
	const deltas: ({ text: string } | { reset: true })[] = [];
	const result = await translate({ cwd, text: doc, signal: new AbortController().signal, onDelta: (delta) => { deltas.push(delta); } });
	const expected = "# TITLE\n\nPARA.\n\n```\ncode\n```\n\nTAIL.";
	assert.equal(result.text, expected);
	assert.deepEqual({ chunks: result.chunks, cachedChunks: result.cachedChunks, language: result.language }, { chunks: 2, cachedChunks: 0, language: "ru" });
	assert.equal(applyDeltas(deltas), expected);
	assert.ok(!deltas.some((delta) => "reset" in delta), "trimmed chunk edges do not force a reset");
	assert.equal(first.calls.length, 2);
	assert.equal((await readdir(join(cwd, TRANSLATION_CACHE_DIRECTORY))).filter((name) => name.endsWith(".json")).length, 2);

	const second = fakeRunner();
	const again = createDocumentTranslator({ runner: second.run, loadConfig: config, cache: createTranslationCache() });
	const edited = await again({ cwd, text: doc.replace("Tail.", "New tail."), signal: new AbortController().signal });
	assert.equal(second.calls.length, 1, "only the edited chunk is translated again");
	assert.equal(edited.cachedChunks, 1);
	assert.equal(edited.text, expected.replace("TAIL.", "NEW TAIL."));

	const refreshed = await again({ cwd, text: doc, refresh: true, signal: new AbortController().signal });
	assert.equal(refreshed.cachedChunks, 0);
	assert.equal(second.calls.length, 3);
});

test("document translation resets to completed text when a chunk falls back", async () => {
	const cwd = project();
	let attempt = 0;
	const run = async (request: AssistModelRequest) => {
		const section = sectionOf(request.prompt);
		if (section === "Second." && attempt++ === 0) {
			await request.onDelta?.({ text: "partial" });
			await request.onDelta?.({ reset: true });
		}
		await request.onDelta?.({ text: section.toUpperCase() });
		return section.toUpperCase();
	};
	const translate = createDocumentTranslator({ runner: run, loadConfig: config, cache: createTranslationCache() });
	const deltas: ({ text: string } | { reset: true })[] = [];
	const doc = `First.\n\n${"x".repeat(4_000)}\n\nSecond.`;
	const result = await translate({ cwd, text: doc, signal: new AbortController().signal, onDelta: (delta) => { deltas.push(delta); } });
	assert.equal(applyDeltas(deltas), result.text);
	assert.ok(deltas.some((delta) => "reset" in delta));
	assert.ok(deltas.every((delta) => "reset" in delta || delta.text.length <= 2_000), "deltas stay within the Desktop notification bound");
});

test("document translation cancellation stops before the next chunk and caches nothing partial", async () => {
	const cwd = project();
	const controller = new AbortController();
	const calls: string[] = [];
	const run = async (request: AssistModelRequest) => {
		calls.push(sectionOf(request.prompt));
		controller.abort(new Error("cancelled"));
		throw new Error("cancelled");
	};
	const translate = createDocumentTranslator({ runner: run, loadConfig: config, cache: createTranslationCache() });
	await assert.rejects(translate({ cwd, text: `A.\n\n${"x".repeat(4_000)}\n\nB.`, signal: controller.signal }), /cancelled/u);
	assert.equal(calls.length, 1);
	await assert.rejects(readdir(join(cwd, TRANSLATION_CACHE_DIRECTORY)));
});

test("translation cache retention drops entries unused past the TTL and keeps the newest", async () => {
	const cwd = project();
	let now = Date.now();
	const cache = createTranslationCache({ maxAgeMs: 1_000_000, maxEntries: 2, now: () => now });
	for (const source of ["a", "b", "c", "d"]) await cache.set(cwd, "ru", source, source.toUpperCase());
	const dir = join(cwd, TRANSLATION_CACHE_DIRECTORY);
	const path = (source: string) => join(dir, `${translationCacheKey("ru", source)}.json`);
	const age = async (source: string, ms: number) => { const time = new Date(now - ms); await utimes(path(source), time, time); };
	await age("a", 2_000_000);
	await age("b", 500);
	await age("c", 400);
	await age("d", 300);
	await writeFile(join(dir, ".orphan.tmp"), "");
	await utimes(join(dir, ".orphan.tmp"), new Date(now - 2 * 86_400_000), new Date(now - 2 * 86_400_000));
	assert.equal(await cache.get(cwd, "ru", "b"), "B", "a hit refreshes the entry's last use");
	assert.equal(await cache.get(cwd, "en", "b"), undefined, "language is part of the key");
	assert.equal(await cache.prune(cwd, true), 3);
	assert.deepEqual((await readdir(dir)).sort(), [`${translationCacheKey("ru", "b")}.json`, `${translationCacheKey("ru", "d")}.json`].sort());
	assert.ok((await stat(path("b"))).mtimeMs >= now - 10);
	now += 1;
	assert.equal(await cache.prune(cwd), 0, "routine pruning is throttled");
});

test("document translate request parser validates text, refresh and request id", () => {
	assert.deepEqual(
		parseDesktopDocumentTranslateRequest({ cwd: "/w", text: "# Hi", path: "wiki/a.md", refresh: true, requestId: "r" }),
		{ cwd: "/w", text: "# Hi", path: "wiki/a.md", refresh: true, requestId: "r" },
	);
	assert.deepEqual(parseDesktopDocumentTranslateRequest({ cwd: "/w", text: "x", refresh: false }), { cwd: "/w", text: "x" });
	assert.throws(() => parseDesktopDocumentTranslateRequest({ cwd: "/w", text: " " }));
	assert.throws(() => parseDesktopDocumentTranslateRequest({ cwd: "/w", text: "x", refresh: "yes" }));
	assert.throws(() => parseDesktopDocumentTranslateRequest({ cwd: "/w", text: "x".repeat(400_001) }));
});
