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
				{ id: 1, subject: "Ship", status: "completed" },
				{ id: 2, subject: "Next", status: "pending" },
			],
		};

		const lines = renderTodoPanel(details, true, 80, THEMES.dark.colors);

		assert.equal(lines.length, 2);
		assert.ok(lines[0]?.text.startsWith(`${APP_ICONS.checkCircle} 1.Ship`));
		assert.ok(lines[0]?.text.endsWith(" "));
		assert.equal(stringDisplayWidth(lines[0]?.text ?? ""), 80);
		assert.equal(lines[0]?.backgroundOverride, undefined);
		assert.deepEqual(lines[0]?.segments, [
			{ start: 0, end: 2, foreground: THEMES.dark.colors.success },
			{ start: 3, end: 9, strikethrough: true },
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
		assert.ok(lines[0]?.text.startsWith(`${APP_ICONS.timerSand} 1.Parent — working`));
		assert.ok(lines[1]?.text.startsWith(`  ↳ ${APP_ICONS.circleOutline} 2.Child parent:#1`));
		assert.ok(lines[2]?.text.startsWith(`${APP_ICONS.deferred} 3.Sibling`));
	});

	it("colors task text using the thinking palette color", () => {
		const details: TodoDetails = {
			action: "list",
			params: {},
			nextId: 3,
			tasks: [
				{ id: 1, subject: "Deep fix", status: "in_progress", thinking: "high" },
				{ id: 2, subject: "Report", status: "pending", thinking: "off" },
			],
		};

		const expanded = renderTodoPanel(details, true, 80, THEMES.dark.colors);
		const collapsed = renderTodoPanel(details, false, 80, THEMES.dark.colors);

		assert.ok(expanded[0]?.text.startsWith(`${APP_ICONS.timerSand} 1.Deep fix`));
		assert.ok(expanded[1]?.text.startsWith(`${APP_ICONS.circleOutline} 2.Report`));
		assert.doesNotMatch(expanded[0]?.text ?? "", /\bhigh\b/u);
		assert.doesNotMatch(expanded[1]?.text ?? "", /\boff\b/u);
		for (const line of [...expanded, ...collapsed]) assert.ok(!line.text.includes(APP_ICONS.lightbulb));
		for (const line of [...expanded, ...collapsed]) assert.doesNotMatch(line.text, /\[(high|off)\]/u);
		assertThinkingSegmentColor(expanded[0]!, "1.Deep fix", THEMES.dark.colors.error);
		assertThinkingSegmentColor(expanded[1]!, "2.Report", THEMES.dark.colors.muted);
		assertThinkingSegmentColor(collapsed[0]!, "1.Deep fix", THEMES.dark.colors.error);
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

function assertThinkingSegmentColor(line: { text: string; segments?: readonly { start: number; end: number; foreground?: string }[] }, label: string, color: string): void {
	const start = line.text.indexOf(label);
	assert.ok(start >= 0, `expected ${label} in ${line.text}`);
	assert.ok(line.segments?.some((segment) => segment.start === start && segment.end === start + label.length && segment.foreground === color));
}
