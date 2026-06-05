import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { fuzzySearch } from "../src/fuzzy.js";

describe("fuzzySearch", () => {
	const items = [
		{ value: "open", label: "Open File", aliases: ["find"], keywords: ["file picker"] },
		{ value: "status", label: "Git Status" },
		{ value: "switch", label: "Switch Session" },
	] as const;

	it("returns ranked matches with matched ranges", () => {
		const matches = fuzzySearch(items, "gs");
		assert.equal(matches[0]?.value, "status");
		assert.equal(matches[0]?.matchedText, "Git Status");
		assert.deepEqual(matches[0]?.matchedRanges, [{ start: 0, end: 1 }, { start: 4, end: 5 }]);
	});

	it("searches aliases and keywords, trims/cases query, and respects limits", () => {
		const [match] = fuzzySearch(items, " PICK ", { limit: 1 });
		assert.equal(match?.value, "open");
		assert.equal(match?.matchedText, "file picker");
	});

	it("matches queries typed with the Russian keyboard layout selected", () => {
		const [match] = fuzzySearch([
			{ value: "new", label: "new" },
			{ value: "resume", label: "resume" },
		], "туц", { limit: 1 });

		assert.equal(match?.value, "new");
		assert.deepEqual(match?.matchedRanges, [{ start: 0, end: 3 }]);
	});

	it("can prefer keyboard-layout matches over literal fuzzy matches", () => {
		const matches = fuzzySearch([
			{ value: "russian", label: "важную логику покрыть" },
			{ value: "sdk", label: "read sdk docs" },
		], "ыВЛ", { preferKeyboardLayoutMatches: true });

		assert.deepEqual(matches.map((match) => match.value), ["sdk"]);
	});

	it("can reject weak dispersed subsequence matches", () => {
		const matches = fuzzySearch([
			{ value: "prompt", label: "Generate one PNG image of a single standalone transparent mobile game asset" },
			{ value: "sdk", label: "read sdk references" },
		], "sdk", { minScorePerCharacter: 8 });

		assert.deepEqual(matches.map((match) => match.value), ["sdk"]);
	});

	it("matches Russian labels from queries typed with the English keyboard layout selected", () => {
		const [match] = fuzzySearch([
			{ value: "new", label: "новый" },
			{ value: "resume", label: "возобновить" },
		], "yjd", { limit: 1 });

		assert.equal(match?.value, "new");
		assert.deepEqual(match?.matchedRanges, [{ start: 0, end: 3 }]);
	});

	it("handles empty and unmatched queries", () => {
		assert.deepEqual(fuzzySearch(items, "", { includeEmptyQuery: false }), []);
		assert.deepEqual(fuzzySearch(items, "zzzz"), []);
		assert.equal(fuzzySearch(items, "").length, items.length);
	});

	it("keeps original rank for tied scores", () => {
		const tied = fuzzySearch([
			{ value: 1, label: "Alpha" },
			{ value: 2, label: "Alps" },
		], "");
		assert.deepEqual(tied.map((match) => match.value), [1, 2]);
	});
});
