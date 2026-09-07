import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS, setAppIconTheme } from "../src/app/icons.js";
import { isSubagentTaskPreview, subagentIcon } from "../src/app/subagents/subagents-model.js";

describe("subagent model icons", () => {
	it("resolves known icon names through the active icon theme", () => {
		setAppIconTheme("nerdFont");
		assert.equal(subagentIcon({ id: "a", icon: "search" }), "\u{f0349}");
		assert.equal(subagentIcon({ id: "a", icon: "terminal" }), "\u{f018d}");

		setAppIconTheme("fallback");
		assert.equal(subagentIcon({ id: "a", icon: "code" }), "{}");
		assert.equal(subagentIcon({ id: "a", icon: "agent" }), "◇");

		setAppIconTheme("nerdFont");
		assert.equal(subagentIcon({ id: "a", icon: "search" }), APP_ICONS.search);
	});

	it("falls back to the neutral agent icon for missing or unknown names", () => {
		assert.equal(subagentIcon(undefined), APP_ICONS.agent);
		assert.equal(subagentIcon({ id: "a" }), APP_ICONS.agent);
		assert.equal(subagentIcon({ id: "a", icon: "does-not-exist" }), APP_ICONS.agent);
		assert.equal(subagentIcon({ id: "a", icon: "  " }), APP_ICONS.agent);
	});

	it("accepts the icon field in task previews", () => {
		assert.equal(isSubagentTaskPreview({ id: "a", icon: "wrench" }), true);
		assert.equal(isSubagentTaskPreview({ id: "a", icon: "" }), true);
		assert.equal(isSubagentTaskPreview({ id: "a", icon: 3 }), false);
	});
});
