import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AppRequestHistory } from "../src/app/session/request-history.js";

describe("AppRequestHistory", () => {
	it("searches recent entries through fuzzy command history", () => {
		const history = new AppRequestHistory(host());
		history.add("npm run check");
		history.add("/model zai/glm-5-turbo");
		history.add("/search old sessions");

		assert.deepEqual(history.search("model"), ["/model zai/glm-5-turbo"]);
		assert.deepEqual(history.search(""), ["/search old sessions", "/model zai/glm-5-turbo", "npm run check"]);
	});

	it("prefers wrong-keyboard-layout matches over literal Cyrillic fuzzy matches", () => {
		const history = new AppRequestHistory(host());
		history.add("продолжаем тестовое покрытие важной логики");
		history.add("read sdk references");

		assert.deepEqual(history.search("ыВЛ"), ["read sdk references"]);
		assert.deepEqual(history.searchMatches("ыВЛ")[0]?.matchedRanges, [{ start: 5, end: 8 }]);
	});

	it("ignores weak dispersed matches in long prompt history", () => {
		const history = new AppRequestHistory(host());
		history.add("Generate one PNG image of a single standalone transparent mobile game asset");
		history.add("read sdk references");

		assert.deepEqual(history.search("sdk"), ["read sdk references"]);
		assert.deepEqual(history.search("asdfasdfasdfsgfsgs"), []);
	});

	it("starts arrow navigation only when the input is empty", () => {
		const emptyHost = host();
		const history = new AppRequestHistory(emptyHost);
		history.add("first");
		history.add("second");

		emptyHost.setInput("draft");
		assert.equal(history.navigate(-1), false);
		assert.equal(emptyHost.getInput(), "draft");

		emptyHost.setInput("");
		assert.equal(history.navigate(-1), true);
		assert.equal(emptyHost.getInput(), "second");
	});
});

function host() {
	let input = "";
	return {
		noSession: true,
		getInput: () => input,
		setInput: (value: string) => {
			input = value;
		},
		resetInputMenuDismissals: () => {},
		render: () => {},
	};
}
