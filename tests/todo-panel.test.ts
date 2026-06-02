import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderSubagentsPanel, renderTodoPanel } from "../src/app/rendering/editor-panels.js";
import { APP_ICONS } from "../src/app/icons.js";
import type { SubagentsWidgetState, TodoDetails } from "../src/app/types.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
import { THEMES } from "../src/theme.js";

describe("todo panel", () => {
	it("strikes through completed task text", () => {
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 3,
			tasks: [
				{ id: 1, subject: "Ship", status: "completed", priority: "high", tags: ["done"] },
				{ id: 2, subject: "Next", status: "pending" },
			],
		};

		const lines = renderTodoPanel(details, true, 80, THEMES.dark.colors);

		assert.equal(lines.length, 2);
		assert.ok(lines[0]?.text.startsWith(`${APP_ICONS.checkCircle} #1 Ship (high) #done`));
		assert.ok(lines[0]?.text.endsWith(" "));
		assert.equal(stringDisplayWidth(lines[0]?.text ?? ""), 80);
		assert.equal(lines[0]?.backgroundOverride, undefined);
		assert.deepEqual(lines[0]?.segments, [
			{ start: 3, end: 5, foreground: THEMES.dark.colors.muted, strikethrough: true },
			{ start: 6, end: 10, strikethrough: true },
			{ start: 11, end: 17, foreground: THEMES.dark.colors.muted, strikethrough: true },
			{ start: 18, end: 23, foreground: THEMES.dark.colors.muted, strikethrough: true },
		]);
	});

	it("hides the panel when only completed tasks remain", () => {
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 2,
			tasks: [{ id: 1, subject: "Done", status: "completed" }],
		};

		assert.deepEqual(renderTodoPanel(details, true, 80, THEMES.dark.colors), []);
		assert.deepEqual(renderTodoPanel(details, false, 80, THEMES.dark.colors), []);
	});

	it("renders task ids and hierarchy in expanded mode", () => {
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 4,
			tasks: [
				{ id: 2, subject: "Child", status: "pending", parentId: 1 },
				{ id: 1, subject: "Parent", status: "in_progress", activeForm: "working" },
				{ id: 3, subject: "Sibling", status: "deferred" },
			],
		};

		const lines = renderTodoPanel(details, true, 80, THEMES.dark.colors);

		assert.equal(lines.length, 3);
		assert.ok(lines[0]?.text.startsWith(`${APP_ICONS.timerSand} #1 Parent — working`));
		assert.ok(lines[1]?.text.startsWith(`  ↳ ${APP_ICONS.circleOutline} #2 Child parent:#1`));
		assert.ok(lines[2]?.text.startsWith(`${APP_ICONS.deferred} #3 Sibling`));
	});

	it("leaves subagents panel rows on the terminal default background", () => {
		const state: SubagentsWidgetState = {
			runDir: "/tmp/subagents/run-1",
			agents: [{ id: "agent-1", status: "running" }],
			tasks: [{ id: "agent-1", task: "Review widget styling" }],
			live: true,
			snapshotOnly: false,
			checkedAt: Date.now(),
		};

		const lines = renderSubagentsPanel(state, true, 80, THEMES.dark.colors);

		assert.equal(lines.length, 1);
		assert.ok(lines[0]?.text.startsWith(APP_ICONS.timerSand));
		assert.ok(lines[0]?.text.endsWith(" "));
		assert.equal(stringDisplayWidth(lines[0]?.text ?? ""), 80);
		assert.equal(lines[0]?.colorOverride, THEMES.dark.colors.muted);
		assert.equal(lines[0]?.backgroundOverride, undefined);
	});
});
