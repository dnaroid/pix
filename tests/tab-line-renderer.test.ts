import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { TabLineRenderer } from "../src/app/rendering/tab-line-renderer.js";
import { APP_ICONS } from "../src/app/icons.js";
import { ScreenStyler } from "../src/app/screen/screen-styler.js";
import type { SessionTab } from "../src/app/types.js";
import { stringDisplayWidth } from "../src/terminal-width.js";
import { colorize, THEMES } from "../src/theme.js";

describe("TabLineRenderer", () => {
	it("renders compact tabs with status icons, vertical-bar gap, and close targets", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main session", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Follow-up", sessionPath: "/tmp/two.jsonl" },
		]);

		const layout = renderer.layout(80);

		assert.doesNotMatch(layout.text, /active|waiting/u);
		assert.ok(layout.text.includes(APP_ICONS.checkCircle));
		assert.equal(layout.text.startsWith(" "), false);
		assert.ok(layout.text.includes("│"));
		assert.ok(layout.text.includes(`${APP_ICONS.close} │ ${APP_ICONS.checkCircle}`));
		assert.ok(layout.text.includes("Main session"));
		assert.ok(layout.text.includes("Follow-up"));
		assert.ok(layout.text.slice(0, layout.text.lastIndexOf(APP_ICONS.plus)).trimEnd().endsWith("│"));
		assert.equal(layout.targets.filter((target) => target.kind === "tab").length, 2);
		assert.equal(layout.targets.filter((target) => target.kind === "close").length, 2);
		assert.equal(layout.targets.filter((target) => target.kind === "new-tab").length, 1);
		assert.equal(layout.targets[0]?.kind, "close");
		assert.ok(layout.text.includes(APP_ICONS.close));
		assert.ok(layout.text.endsWith(APP_ICONS.plus));
		assert.ok(layout.text.endsWith(`${APP_ICONS.close} │ ${APP_ICONS.plus}`));
		assert.deepEqual(layout.targets.find((target) => target.kind === "new-tab"), {
			kind: "new-tab",
			startColumn: 36,
			endColumn: 37,
		});
	});

	it("renders default generated session titles as session ids", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "session 019e7d3f", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Session 019e7d3f", sessionPath: "/tmp/two.jsonl" },
			{ id: "tab-3", status: "waiting", title: "session work notes", sessionPath: "/tmp/three.jsonl" },
		]);

		const layout = renderer.layout(80);

		assert.doesNotMatch(layout.text, /New/u);
		assert.ok(layout.text.includes("session 019e7d3f"));
		assert.ok(layout.text.includes("Session 019e7d3f"));
		assert.ok(layout.text.includes("session work notes"));
	});

	it("renders startup-loading default generated session titles as session ids", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "session 019e7d3f", titlePlaceholder: "loading", sessionPath: "/tmp/one.jsonl" },
		]);

		const layout = renderer.layout(80);

		assert.ok(layout.text.includes("session 019e7d3f"));
		assert.doesNotMatch(layout.text, /Loading…/u);
		assert.doesNotMatch(layout.text, /New/u);
	});

	it("renders the active tab without a panel background", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main session", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Follow-up", sessionPath: "/tmp/two.jsonl" },
		]);

		const layout = renderer.layout(80);
		const activeTitleStart = layout.text.indexOf("Main session");
		const activeTitleEnd = activeTitleStart + "Main session".length;

		assert.equal(layout.segments.some((segment) => segment.background), false);
		assert.ok(layout.segments.some((segment) => segment.start === 0 && segment.end === APP_ICONS.checkCircle.length && segment.foreground === THEMES.dark.colors.statusDotBase));
		assert.ok(layout.segments.some((segment) => segment.start <= activeTitleStart && segment.end >= activeTitleEnd && segment.foreground === THEMES.dark.colors.selectionForeground));
		const rendered = renderer.render(1, layout, 80);
		assert.ok(rendered.includes(colorize(" Main session ", {
			foreground: THEMES.dark.colors.selectionForeground,
		})));
		assert.doesNotMatch(rendered, /\x1b\[[^m]*48;2/u);
	});

	it("renders the full visible tab row without underlining it", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Follow-up", sessionPath: "/tmp/two.jsonl" },
		]);

		const layout = renderer.layout(40);
		const rendered = renderer.render(1, layout, 40);
		const sgrCodes = [...rendered.matchAll(/\x1b\[([^m]+)m/g)].map((match) => match[1]).filter((codes) => codes !== "0");

		assert.equal(stringDisplayWidth(stripAnsi(rendered)), 40);
		assert.ok(sgrCodes.length > 0);
		assert.equal(sgrCodes.some((codes) => codes?.split(";").includes("4")), false);
	});

	it("leaves a gap in the bottom rule under the active tab", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Follow-up", sessionPath: "/tmp/two.jsonl" },
		]);

		const layout = renderer.layout(40);
		const bottomText = renderer.bottomText(layout, 40);
		const activeTarget = layout.targets.find((target) => target.kind === "tab" && target.active);

		assert.ok(activeTarget);
		const leftSeparator = Math.max(0, ...layout.separatorColumns.filter((column) => column < activeTarget.startColumn));
		const rightSeparator = Math.min(41, ...layout.separatorColumns.filter((column) => column >= activeTarget.endColumn));
		assert.equal(stringDisplayWidth(bottomText), 40);
		assert.equal(bottomText.slice(leftSeparator, rightSeparator - 1), " ".repeat(rightSeparator - leftSeparator - 1));
		assert.equal(bottomText[rightSeparator - 1], "└");
		assert.ok(bottomText.slice(rightSeparator).includes("─"));
	});

	it("colors the new-tab button blue and places it after the last tab", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
		]);

		const layout = renderer.layout(20);
		const newTabTarget = layout.targets.find((target) => target.kind === "new-tab");
		const plusStart = layout.text.indexOf(APP_ICONS.plus);
		const dividerColumn = 10;

		assert.deepEqual(newTabTarget, { kind: "new-tab", startColumn: 12, endColumn: 13 });
		assert.equal([...layout.text][dividerColumn - 1], "│");
		assert.equal(renderer.bottomText(layout, 20)[dividerColumn - 1], "└");
		assert.ok(layout.segments.some((segment) => (
			segment.start === plusStart
			&& segment.end === plusStart + APP_ICONS.plus.length
			&& segment.foreground === THEMES.dark.colors.info
			&& segment.bold === true
		)));
	});

	it("uses the muted close color for active and inactive tabs", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Follow-up", sessionPath: "/tmp/two.jsonl" },
		]);

		const layout = renderer.layout(80);

		assert.deepEqual(closeSegmentForegrounds(layout), [THEMES.dark.colors.muted, THEMES.dark.colors.muted]);
	});

	it("renders stopped, running, and bell attention status icons", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Stopped", activity: "idle", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Running", activity: "running", sessionPath: "/tmp/two.jsonl" },
			{ id: "tab-3", status: "waiting", title: "Needs attention", activity: "idle", attention: "terminal-bell", attentionVisible: true, sessionPath: "/tmp/three.jsonl" },
		]);

		const layout = renderer.layout(100);

		assert.ok(layout.text.includes(APP_ICONS.checkCircle));
		assert.ok(layout.text.includes(APP_ICONS.timerSand));
		assert.ok(layout.text.includes(APP_ICONS.alert));
		const foregrounds = statusSegmentForegrounds(layout);
		assert.ok(foregrounds.includes(THEMES.dark.colors.statusDotBase));
		assert.ok(foregrounds.includes(THEMES.dark.colors.success));
		assert.ok(foregrounds.includes(THEMES.dark.colors.error));
	});

	it("dims a bell attention indicator on alternate blink frames", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", activity: "idle", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Done", activity: "idle", attention: "terminal-bell", attentionVisible: false, sessionPath: "/tmp/two.jsonl" },
		]);

		const layout = renderer.layout(80);

		assert.deepEqual(statusSegmentForegrounds(layout), [THEMES.dark.colors.statusDotBase, THEMES.dark.colors.statusDotBase]);
		assert.equal(layout.text.split(APP_ICONS.checkCircle).length - 1, 2);
	});

	it("renders a single tab and keeps the new-tab button", () => {
		const renderer = tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main session", sessionPath: "/tmp/one.jsonl" },
		]);

		const layout = renderer.layout(80);

		assert.ok(layout.text.includes(APP_ICONS.checkCircle));
		assert.ok(layout.text.includes("Main session"));
		assert.ok(layout.text.includes(APP_ICONS.close));
		assert.equal(layout.targets.filter((target) => target.kind === "tab").length, 1);
		assert.equal(layout.targets.filter((target) => target.kind === "close").length, 1);
		assert.ok(layout.text.endsWith(APP_ICONS.plus));
		assert.equal(layout.targets.filter((target) => target.kind === "new-tab").length, 1);
	});

	it("reserves panel rows even when there is only one tab", () => {
		assert.equal(tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
		]).panelRows(10), 2);
		assert.equal(tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
			{ id: "tab-2", status: "waiting", title: "Follow-up", sessionPath: "/tmp/two.jsonl" },
		]).panelRows(10), 2);
		assert.equal(tabLineRenderer([
			{ id: "tab-1", status: "active", title: "Main", sessionPath: "/tmp/one.jsonl" },
		]).panelRows(2), 1);
	});

	it("shows the new-tab button when there are no tabs", () => {
		const renderer = tabLineRenderer([]);

		const layout = renderer.layout(80);

		assert.equal(layout.text.trim(), `│ ${APP_ICONS.plus}`);
		assert.deepEqual(layout.targets, [{ kind: "new-tab", startColumn: 3, endColumn: 4 }]);
	});

	it("keeps several tabs within the available terminal width by ellipsizing titles", () => {
		const renderer = tabLineRenderer(Array.from({ length: 5 }, (_, index): SessionTab => ({
			id: `tab-${index}`,
			status: index === 0 ? "active" : "waiting",
			title: `Very long restored session title ${index}`,
			sessionPath: `/tmp/${index}.jsonl`,
		})));

		const layout = renderer.layout(60);

		assert.ok(stringDisplayWidth(layout.text) <= 60);
		assert.ok(layout.text.includes("…"));
		assert.ok(layout.text.endsWith(APP_ICONS.plus));
		assert.equal(layout.targets.filter((target) => target.kind === "tab").length, 5);
	});
});

function statusSegmentForegrounds(layout: ReturnType<TabLineRenderer["layout"]>): (string | undefined)[] {
	const statusIcons = new Set<string>([APP_ICONS.alert, APP_ICONS.checkCircle, APP_ICONS.timerSand]);
	return layout.segments
		.filter((segment) => statusIcons.has(layout.text.slice(segment.start, segment.end)))
		.map((segment) => segment.foreground);
}

function closeSegmentForegrounds(layout: ReturnType<TabLineRenderer["layout"]>): (string | undefined)[] {
	return layout.segments
		.filter((segment) => layout.text.slice(segment.start, segment.end) === APP_ICONS.close)
		.map((segment) => segment.foreground);
}

function tabLineRenderer(tabs: readonly SessionTab[]): TabLineRenderer {
	return new TabLineRenderer({
		theme: THEMES.dark,
		screenStyler: new ScreenStyler({ theme: THEMES.dark, mouseSelection: undefined }),
		tabs,
	});
}

function stripAnsi(text: string): string {
	return text.replaceAll(/\x1b\[[0-9;]*m/g, "");
}
