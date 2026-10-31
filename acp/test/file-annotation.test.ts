import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistModelRequest } from "../src/acp/assist-model-runner.js";
import { parseDesktopFileAnnotateRequest } from "../src/acp/desktop-commands.js";
import { createFileAnnotator, parseFileAnnotations } from "../src/acp/file-annotation.js";

test("annotation parser tolerates fences and prose, validates, merges and sorts notes", () => {
	const output = 'Here:\n```json\n[{"line": 3, "text": "Second"}, {"line": "1", "note": " First\\n note "}, {"line": 3, "text": "more"}, {"line": 9, "text": "out of range"}, {"line": 2, "text": ""}, "junk"]\n```';
	assert.deepEqual(parseFileAnnotations(output, 5), [{ line: 1, text: "First note" }, { line: 3, text: "Second more" }]);
	assert.deepEqual(parseFileAnnotations("no json here", 5), []);
	assert.deepEqual(parseFileAnnotations("[not json]", 5), []);
});

test("annotator lists numbered lines, uses the configured language and reports coverage", async () => {
	const requests: AssistModelRequest[] = [];
	const annotate = createFileAnnotator({
		runner: async (request) => { requests.push(request); return '[{"line": 2, "text": "Counts clicks."}]'; },
		loadConfig: () => ({ modelRefs: ["p/m"], language: "ru" }),
	});
	const result = await annotate({ cwd: "/w", path: "src/a.ts", text: "let a = 0;\r\nfunction f() {}\n", signal: new AbortController().signal });
	assert.deepEqual(result, { annotations: [{ line: 2, text: "Counts clicks." }], language: "ru", annotatedLines: 3, totalLines: 3 });
	assert.match(requests[0]!.prompt, /^File: src\/a\.ts\n<file>\n1\| let a = 0;\n2\| function f\(\) \{\}\n3\| \n<\/file>$/u);
	assert.match(requests[0]!.systemPrompt, /ru/u);
});

test("annotator truncates very large files and rejects empty model output", async () => {
	let prompt = "";
	const annotate = createFileAnnotator({
		runner: async (request) => { prompt = request.prompt; return "[]"; },
		loadConfig: () => ({ modelRefs: ["p/m"], language: "en" }),
	});
	const text = Array.from({ length: 5_000 }, (_, index) => `line ${index}`).join("\n");
	await assert.rejects(annotate({ cwd: "/w", text, signal: new AbortController().signal }), /no usable annotations/u);
	assert.match(prompt, /Only the beginning/u);
	assert.equal(prompt.split("\n").filter((line) => /^\s*\d+\| /u.test(line)).length, 3_000);
});

test("file annotate request parser", () => {
	assert.deepEqual(parseDesktopFileAnnotateRequest({ cwd: "/w", text: "x", path: "a.ts" }), { cwd: "/w", text: "x", path: "a.ts" });
	assert.throws(() => parseDesktopFileAnnotateRequest({ cwd: "/w", text: "  " }));
	assert.throws(() => parseDesktopFileAnnotateRequest({ cwd: "", text: "x" }));
});
