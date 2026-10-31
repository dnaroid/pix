import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { AssistModelRequest } from "../src/acp/assist-model-runner.js";
import { parseDesktopFileAnnotateRequest } from "../src/acp/desktop-commands.js";
import { EXPLANATION_CACHE_DIRECTORY, createFileAnnotator, parseFileAnnotations, parseFileExplanation } from "../src/acp/file-annotation.js";

const project = () => mkdtempSync(join(tmpdir(), "pix-file-annotation-"));
const signal = () => new AbortController().signal;

test("annotation parser tolerates fences and prose, validates, merges and sorts notes", () => {
	const output = 'Here:\n```json\n[{"line": 3, "text": "Second"}, {"line": "1", "note": " First\\n note "}, {"line": 3, "text": "more"}, {"line": 9, "text": "out of range"}, {"line": 2, "text": ""}, "junk"]\n```';
	assert.deepEqual(parseFileAnnotations(output, 5), [{ line: 1, text: "First note" }, { line: 3, text: "Second more" }]);
	assert.deepEqual(parseFileAnnotations("no json here", 5), []);
	assert.deepEqual(parseFileAnnotations("[not json]", 5), []);
});

test("explanation parser reads the summary object and falls back to a bare notes array", () => {
	assert.deepEqual(
		parseFileExplanation('```json\n{"summary": "  Runs   evals.\\n\\n\\n\\nTwo modes. ", "notes": [{"line": 2, "text": "Loop."}]}\n```', 4),
		{ summary: "Runs evals.\n\nTwo modes.", annotations: [{ line: 2, text: "Loop." }] },
	);
	assert.deepEqual(parseFileExplanation('[{"line": 1, "text": "Only notes {x}"}]', 4), { summary: "", annotations: [{ line: 1, text: "Only notes {x}" }] });
	assert.deepEqual(parseFileExplanation("nothing", 4), { summary: "", annotations: [] });
});

function fakeRunner(answer = '{"summary": "Counts clicks.", "notes": [{"line": 2, "text": "Declares `f`."}]}') {
	const requests: AssistModelRequest[] = [];
	return { requests, run: async (request: AssistModelRequest) => { requests.push(request); return answer; } };
}

test("explainer lists numbered lines, returns the summary and caches by path", async () => {
	const cwd = project();
	const runner = fakeRunner();
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: () => ({ modelRefs: ["p/m"], language: "ru" }) });
	const text = "let a = 0;\r\nfunction f() {}\n";
	const first = await explain({ cwd, path: "src/a.ts", text, signal: signal() });
	assert.deepEqual(first, { summary: "Counts clicks.", annotations: [{ line: 2, text: "Declares `f`." }], language: "ru", annotatedLines: 3, totalLines: 3, cached: false });
	assert.match(runner.requests[0]!.prompt, /^File: src\/a\.ts\n<file>\n1\| let a = 0;\n2\| function f\(\) \{\}\n3\| \n<\/file>$/u);
	assert.match(runner.requests[0]!.systemPrompt, /"summary"/u);

	const again = await explain({ cwd, path: "src/a.ts", text, signal: signal() });
	assert.equal(again.cached, true);
	assert.equal(again.summary, "Counts clicks.");
	assert.equal(runner.requests.length, 1);

	const refreshed = await explain({ cwd, path: "src/a.ts", text, refresh: true, signal: signal() });
	assert.equal(refreshed.cached, false);
	assert.equal(runner.requests.length, 2);
});

test("an edited source or another language invalidates the cached explanation", async () => {
	const cwd = project();
	const runner = fakeRunner();
	let language = "ru";
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: () => ({ modelRefs: ["p/m"], language }) });
	await explain({ cwd, path: "src/a.ts", text: "a\nb\n", signal: signal() });
	const edited = await explain({ cwd, path: "src/a.ts", text: "a\nb changed\n", signal: signal() });
	assert.equal(edited.cached, false, "an edit is a miss");
	assert.equal((await explain({ cwd, path: "src/a.ts", text: "a\nb\n", signal: signal() })).cached, false, "the old content was replaced, not kept");
	language = "en";
	assert.equal((await explain({ cwd, path: "src/a.ts", text: "a\nb\n", signal: signal() })).cached, false);
	assert.equal(runner.requests.length, 4);
	const entries = (await readdir(join(cwd, EXPLANATION_CACHE_DIRECTORY))).filter((name) => name.endsWith(".json"));
	assert.equal(entries.length, 1, "one entry per file path");
});

test("explainer truncates very large files and rejects an empty answer without caching it", async () => {
	const cwd = project();
	const runner = fakeRunner('{"summary": "", "notes": []}');
	const explain = createFileAnnotator({ runner: runner.run, loadConfig: () => ({ modelRefs: ["p/m"], language: "en" }) });
	const text = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n");
	await assert.rejects(explain({ cwd, text, signal: signal() }), /no usable explanation/u);
	assert.match(runner.requests[0]!.prompt, /Only the beginning/u);
	assert.equal(runner.requests[0]!.prompt.split("\n").filter((line) => /^\s*\d+\| /u.test(line)).length, 3_000);
	await assert.rejects(readdir(join(cwd, EXPLANATION_CACHE_DIRECTORY)));
});

test("file annotate request parser", () => {
	assert.deepEqual(parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", path: "a.ts", refresh: true }), { cwd: "/w", text: "x", path: "a.ts", refresh: true });
	assert.deepEqual(parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", refresh: false }), { cwd: "/w", text: "x" });
	assert.throws(() => parseDesktopFileAnnotateRequest({ cwd: "/w", text: "  " }));
	assert.throws(() => parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", refresh: 1 }));
});
