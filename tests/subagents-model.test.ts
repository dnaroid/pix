import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_ICONS, setAppIconTheme } from "../src/app/icons.js";
import { renderSubagentsPanel } from "../src/app/rendering/editor-panels.js";
import {
	formatSubagentLastActivity,
	isSubagentAgentState,
	isSubagentTaskPreview,
	subagentIcon,
} from "../src/app/subagents/subagents-model.js";
import { THEMES } from "../src/theme.js";

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

describe("subagent activity", () => {
	it("validates optional last activity metadata", () => {
		assert.equal(isSubagentAgentState({ id: "a", status: "running", lastActivity: { label: "Grep", at: "2026-09-08T12:00:00.000Z" } }), true);
		assert.equal(isSubagentAgentState({ id: "a", status: "running", lastActivity: { label: "", at: "2026-09-08T12:00:00.000Z" } }), false);
		assert.equal(isSubagentAgentState({ id: "a", status: "running", lastActivity: { label: "Grep", at: 1 } }), false);
	});

	it("formats only the activity label", () => {
		assert.equal(formatSubagentLastActivity({ label: "Grep", at: "2026-09-08T12:00:00.000Z" }), "Grep");
		assert.equal(formatSubagentLastActivity({ label: " Thinking ", at: "invalid" }), "Thinking");
		assert.equal(formatSubagentLastActivity(undefined), undefined);
	});

	it("renders task, activity, then total elapsed time", () => {
		const now = Date.now();
		const [line] = renderSubagentsPanel({
			runDir: "/tmp/run",
			agents: [{
				id: "agent-1",
				status: "running",
				startedAt: new Date(now - 12_000).toISOString(),
				lastActivity: { label: "Grep", at: new Date(now - 3_000).toISOString() },
			}],
			tasks: [{ id: "agent-1", task: "Inspect code", model: "provider/model" }],
			live: true,
			snapshotOnly: false,
			checkedAt: now,
		}, true, 120, THEMES.dark.colors);
		assert.match(line?.text.trimEnd() ?? "", /Inspect code Grep \d+s$/);
		assert.equal(line?.text.includes("Grep ·"), false);
	});
});
