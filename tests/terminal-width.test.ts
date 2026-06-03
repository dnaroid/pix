import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
	expandTabs,
	padOrTrimDisplay,
	sliceByDisplayWidth,
	stringDisplayWidth,
	wrapDisplayLine,
	wrapDisplayLineByWords,
} from "../src/terminal-width.js";

describe("terminal width helpers", () => {
	it("expands tabs from the current display column", () => {
		assert.equal(expandTabs("a\tb", 4), "a   b");
		assert.equal(expandTabs("abcd\tx", 4), "abcd    x");
		assert.equal(expandTabs("ab\n\tc", 4), "ab\n    c");
	});

	it("measures control, combining, emoji, and CJK characters", () => {
		assert.equal(stringDisplayWidth("a\u0000\u0007b"), 2);
		assert.equal(stringDisplayWidth("e\u0301"), 1);
		assert.equal(stringDisplayWidth("表🙂"), 4);
		assert.equal(stringDisplayWidth("❌"), 2);
		assert.equal(stringDisplayWidth("✔️"), 2);
		assert.equal(stringDisplayWidth("👨‍👩‍👧‍👦"), 2);
		assert.equal(stringDisplayWidth("\x1b[31mred\x1b[0m"), 3);
	});

	it("slices and pads by display width without splitting wide characters", () => {
		assert.equal(sliceByDisplayWidth("ab表c", 3), "ab");
		assert.equal(sliceByDisplayWidth("ab表c", 4), "ab表");
		assert.equal(sliceByDisplayWidth("a✔️b", 3), "a✔️");
		assert.equal(sliceByDisplayWidth("abc", -1), "");
		assert.equal(padOrTrimDisplay("表x", 4), "表x ");
		assert.equal(padOrTrimDisplay("表x", 2), "表");
		assert.equal(padOrTrimDisplay("\x1b[31mred\x1b[0m", 5), "\x1b[31mred\x1b[0m  ");
	});

	it("wraps by display width and always returns at least one chunk", () => {
		assert.deepEqual(wrapDisplayLine("ab表cd", 4), ["ab表", "cd"]);
		assert.deepEqual(wrapDisplayLine("", 4), [""]);
		assert.deepEqual(wrapDisplayLine("abc", 0), ["a", "b", "c"]);
	});

	it("wraps by words and falls back to display-width chunks for long words", () => {
		assert.deepEqual(wrapDisplayLineByWords("alpha beta gamma", 12), ["alpha beta", "gamma"]);
		assert.deepEqual(wrapDisplayLineByWords("superlongword", 5), ["super", "longw", "ord"]);
		assert.deepEqual(wrapDisplayLineByWords("one 表🙂 two", 8), ["one 表🙂", "two"]);
	});
});
