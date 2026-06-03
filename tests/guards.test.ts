import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { isNumberArray, isRecord, isStringArray } from "../src/app/guards.js";

describe("type guards", () => {
	it("recognizes plain records", () => {
		assert.equal(isRecord({}), true);
		assert.equal(isRecord([]), true);
		assert.equal(isRecord(null), false);
		assert.equal(isRecord("value"), false);
	});

	it("recognizes homogeneous primitive arrays", () => {
		assert.equal(isStringArray(["a", "b"]), true);
		assert.equal(isStringArray(["a", 1]), false);
		assert.equal(isStringArray("a"), false);

		assert.equal(isNumberArray([1, 2]), true);
		assert.equal(isNumberArray([1, "2"]), false);
		assert.equal(isNumberArray({ 0: 1 }), false);
	});
});
