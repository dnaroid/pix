import assert from "node:assert/strict";
import { test } from "node:test";
import { parseFileAnnotations, parseFileExplanation } from "../src/acp/file-explanation-parser.js";

const bounds = (lastLine: number, firstLine = 1) => ({ firstLine, lastLine, maxNotes: 40 });

test("annotation parser tolerates fences and prose, validates, merges and sorts notes", () => {
	const output = 'Here:\n```json\n[{"line": 3, "text": "Second"}, {"line": "1", "note": " First\\n note "}, {"line": 3, "text": "more"}, {"line": 9, "text": "out of range"}, {"line": 2, "text": ""}, "junk"]\n```';
	assert.deepEqual(parseFileAnnotations(output, bounds(5)), [{ line: 1, text: "First note" }, { line: 3, text: "Second more" }]);
	assert.deepEqual(parseFileAnnotations("no json here", bounds(5)), []);
	assert.deepEqual(parseFileAnnotations("[not json]", bounds(5)), []);
});

test("explanation parser reads the summary object and clamps notes to the part", () => {
	assert.deepEqual(
		parseFileExplanation('```json\n{"summary": "  Runs   evals.\\n\\n\\n\\nTwo modes. ", "notes": [{"line": 2, "text": "Loop."}, {"line": 12, "text": "In part."}]}\n```', bounds(20, 10)),
		{ summary: "Runs evals.\n\nTwo modes.", annotations: [{ line: 12, text: "In part." }] },
	);
	assert.deepEqual(parseFileExplanation('[{"line": 1, "text": "Only notes {x}"}]', bounds(4)), { summary: "", annotations: [{ line: 1, text: "Only notes {x}" }] });
	assert.deepEqual(parseFileExplanation("nothing", bounds(4)), { summary: "", annotations: [] });
});

test("explanation parser salvages answers cut off at the token limit", () => {
	const output = '```json\n{"summary": "Оценивает ответы \\"heads-up\\".", "notes": [{"line": 2, "text": "Строит `context`."}, {"line": 4, "text": "Считает {tp, fn}."}, {"line": 5, "text": "Обре';
	assert.deepEqual(parseFileExplanation(output, bounds(9)), {
		summary: 'Оценивает ответы "heads-up".',
		annotations: [{ line: 2, text: "Строит `context`." }, { line: 4, text: "Считает {tp, fn}." }],
	});
	assert.deepEqual(parseFileExplanation('{"summary": "Starts here and is cut', bounds(3)), { summary: "Starts here and is cut", annotations: [] });
});

test("salvage repairs raw newlines and trailing commas, ignores field order and braces in text", () => {
	const rawNewlines = '{"summary": "Line one.\nLine two.", "notes": [{"line": 1, "text": "First\nnote"},],}';
	assert.deepEqual(parseFileExplanation(rawNewlines, bounds(3)), { summary: "Line one.\nLine two.", annotations: [{ line: 1, text: "First note" }] });
	const mixed = '{"summary": "S", "notes": [{"line": 1, "text": "Uses `{ a }` and \\"q\\"."}, {"text": "Reverse order", "line": 3}, {"line": 4, "text": "x",}, {"line": 2, "text": "Cut';
	assert.deepEqual(parseFileExplanation(mixed, bounds(5)), {
		summary: "S",
		annotations: [{ line: 1, text: 'Uses `{ a }` and "q".' }, { line: 3, text: "Reverse order" }, { line: 4, text: "x" }],
	});
	const strictArrayBrokenObject = '{"summary": "S", "notes": [{"text": "A", "line": 2}]';
	assert.deepEqual(parseFileExplanation(strictArrayBrokenObject, bounds(5)), { summary: "S", annotations: [{ line: 2, text: "A" }] });
});
