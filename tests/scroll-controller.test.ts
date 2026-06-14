import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConversationViewport } from "../src/app/rendering/conversation-viewport.js";
import type { EditorLayoutRenderer } from "../src/app/rendering/editor-layout-renderer.js";
import { AppScrollController, type AppScrollControllerHost } from "../src/app/screen/scroll-controller.js";

describe("AppScrollController", () => {
	it("uses the full conversation width even when content is scrollable", () => {
		let slicedWidth: number | undefined;
		const controller = createController({
			lineCount: (width) => width === 10 ? 2 : 3,
			slice: (width) => {
				slicedWidth = width;
				return [{ text: "visible" }];
			},
		});

		const view = controller.conversationView(10, 1);

		assert.equal(view.metrics.viewportColumns, 10);
		assert.equal(view.metrics.conversationLineCount, 2);
		assert.equal(slicedWidth, 10);
	});

	it("does not reserve a scrollbar gutter that would wrap content", () => {
		const controller = createController({
			lineCount: (width) => width === 10 ? 1 : 2,
			slice: () => [{ text: "visible" }],
		});

		const view = controller.conversationView(10, 1);

		assert.equal(view.metrics.viewportColumns, 10);
		assert.equal(view.metrics.conversationLineCount, 1);
	});

	it("scrolls to the rendered line containing a text sample", () => {
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => 8,
			slice: (_width, start) => {
				slicedStart = start;
				return [{ text: "visible" }];
			},
			entryBlockPositionById: (_width, entryId) => [
				entryPosition("entry-1", 0, ["alpha", "beta"]),
				entryPosition("entry-2", 3, ["start", "the needle sample is here", "end"]),
			].find((position) => position.entry.id === entryId),
		});

		assert.equal(controller.scrollToConversationText({ entryId: "entry-2", needles: ["needle sample"] }), true);
		controller.conversationView(10, 2);

		assert.equal(slicedStart, 4);
	});

	it("falls back to entry offset when no rendered line contains the sample", () => {
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => 8,
			slice: (_width, start) => {
				slicedStart = start;
				return [{ text: "visible" }];
			},
			entryBlockPositionById: (_width, entryId) => [
				entryPosition("entry-1", 0, ["earlier needle sample", "beta"]),
				entryPosition("entry-2", 3, ["start", "different text", "end"]),
			].find((position) => position.entry.id === entryId),
		});

		assert.equal(controller.scrollToConversationText({ entryId: "entry-2", needles: ["needle sample"] }), true);
		controller.conversationView(10, 2);

		assert.equal(slicedStart, 3);
	});

	it("searches raw candidate entries before scanning all rendered positions", () => {
		let fullPositionScanCount = 0;
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => 8,
			slice: (_width, start) => {
				slicedStart = start;
				return [{ text: "visible" }];
			},
			entries: () => [
				{ id: "entry-1", kind: "assistant", text: "alpha" },
				{ id: "entry-2", kind: "assistant", text: "raw needle sample" },
			],
			entryBlockPositionById: (_width, entryId) => [
				entryPosition("entry-1", 0, ["alpha"]),
				entryPosition("entry-2", 3, ["rendered needle sample"]),
			].find((position) => position.entry.id === entryId),
			entryBlockPositions: () => {
				fullPositionScanCount += 1;
				return [];
			},
		});

		assert.equal(controller.scrollToConversationText({ needles: ["needle sample"] }), true);
		controller.conversationView(10, 2);

		assert.equal(slicedStart, 3);
		assert.equal(fullPositionScanCount, 0);
	});

	it("falls back to scanning rendered positions when raw candidates do not match", () => {
		let fullPositionScanCount = 0;
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => 8,
			slice: (_width, start) => {
				slicedStart = start;
				return [{ text: "visible" }];
			},
			entries: () => [
				{ id: "entry-1", kind: "assistant", text: "alpha" },
				{ id: "entry-2", kind: "assistant", text: "beta" },
			],
			entryBlockPositionById: () => undefined,
			entryBlockPositions: () => {
				fullPositionScanCount += 1;
				return [entryPosition("entry-2", 3, ["rendered needle sample"])];
			},
		});

		assert.equal(controller.scrollToConversationText({ needles: ["needle sample"] }), true);
		controller.conversationView(10, 2);

		assert.equal(slicedStart, 3);
		assert.equal(fullPositionScanCount, 1);
	});

	it("preserves the visible anchor when older history is prepended", async () => {
		let lineCount = 20;
		let rendered = 0;
		let loadCount = 0;
		const controller = createController({
			lineCount: () => lineCount,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
			measuredLineCountForEntries: () => 5,
		}, 5, {
			hasOlderSessionHistory: () => loadCount < 1,
			isLoadingOlderSessionHistory: () => false,
			loadOlderSessionHistory: (options) => {
				loadCount += 1;
				lineCount += 5;
				options?.onPrependedEntries?.([{ id: "older", kind: "assistant", text: "older" }]);
				return Promise.resolve(true);
			},
			render: () => { rendered += 1; },
		});

		assert.equal(controller.scrollByLines(-10), true);
		await Promise.resolve();

		assert.equal(controller.conversationView(10, 5).metrics.start, 10);
		assert.ok(rendered > 0);
	});

	it("pins to absolute top when an upward scroll clamps to the top while loading older history", async () => {
		let lineCount = 20;
		let loadCount = 0;
		const controller = createController({
			lineCount: () => lineCount,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
			measuredLineCountForEntries: () => 5,
		}, 5, {
			hasOlderSessionHistory: () => loadCount < 1,
			isLoadingOlderSessionHistory: () => false,
			loadOlderSessionHistory: (options) => {
				loadCount += 1;
				lineCount += 5;
				options?.onPrependedEntries?.([{ id: "older", kind: "assistant", text: "older" }]);
				return Promise.resolve(true);
			},
		});

		assert.equal(controller.scrollByLines(-20, { render: false }), true);
		await Promise.resolve();

		assert.equal(loadCount, 1);
		assert.equal(controller.conversationView(10, 5).metrics.start, 0);
	});

	it("loads older history on the same large upward scroll that reaches the top", async () => {
		let lineCount = 100;
		let loadCount = 0;
		const controller = createController({
			lineCount: () => lineCount,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
			measuredLineCountForEntries: () => 5,
		}, 5, {
			hasOlderSessionHistory: () => true,
			isLoadingOlderSessionHistory: () => false,
			loadOlderSessionHistory: (options) => {
				loadCount += 1;
				lineCount += 5;
				options?.onPrependedEntries?.([{ id: "older", kind: "assistant", text: "older" }]);
				return Promise.resolve(true);
			},
		});

		assert.equal(controller.scrollByLines(-200, { render: false }), true);
		await Promise.resolve();

		assert.equal(loadCount, 1);
	});

	it("does not measure prepended history when no detached anchor is active", async () => {
		let lineCount = 3;
		let measuredLineCountCalls = 0;
		const controller = createController({
			lineCount: () => lineCount,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
			measuredLineCountForEntries: () => {
				measuredLineCountCalls += 1;
				return 5;
			},
		}, 5, {
			hasOlderSessionHistory: () => true,
			isLoadingOlderSessionHistory: () => false,
			loadOlderSessionHistory: (options) => {
				lineCount += 5;
				options?.onPrependedEntries?.([{ id: "older", kind: "assistant", text: "older" }]);
				return Promise.resolve(true);
			},
		});

		assert.equal(controller.scrollByLines(-1, { render: false }), true);
		await Promise.resolve();

		assert.equal(measuredLineCountCalls, 0);
		assert.equal(controller.conversationView(10, 5).metrics.start, 0);
	});

	it("preserves a detached visible anchor when appended messages prune the oldest lines", () => {
		let lineCount = 100;
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => lineCount,
			slice: (_width, start, count) => {
				slicedStart = start;
				return Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` }));
			},
		}, 5);

		assert.equal(controller.scrollByLines(-20, { render: false }), true);
		assert.equal(controller.conversationView(10, 5).metrics.start, 75);

		lineCount -= 10;
		controller.adjustForHistoryWindowPrune("top", 10);

		assert.equal(controller.conversationView(10, 5).metrics.start, 65);
		assert.equal(slicedStart, 65);
	});

	it("can return a detached viewport to the bottom", () => {
		const controller = createController({
			lineCount: () => 20,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
		}, 5);

		assert.equal(controller.scrollByLines(-4, { render: false }), true);
		assert.equal(controller.conversationView(10, 5).metrics.start, 11);

		assert.equal(controller.scrollToBottom(), true);
		assert.equal(controller.conversationView(10, 5).metrics.start, 15);
		assert.equal(controller.scrollToBottom(), false);
	});

	it("exposes an up quick-scroll direction when older history is still lazy-loaded", () => {
		const controller = createController({
			lineCount: () => 4,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
		}, 5, {
			hasOlderSessionHistory: () => true,
		});

		assert.deepEqual(controller.quickScrollDirections(10, 5), { up: true, down: false });
	});

	it("loads all lazy older history before jumping to the absolute top", async () => {
		let lineCount = 4;
		let olderBatches = 2;
		let renders = 0;
		const rendersBeforeLoad: number[] = [];
		const controller = createController({
			lineCount: () => lineCount,
			slice: (_width, start, count) => Array.from({ length: count }, (_, index) => ({ text: `line ${start + index}` })),
		}, 5, {
			hasOlderSessionHistory: () => olderBatches > 0,
			isLoadingOlderSessionHistory: () => false,
			loadOlderSessionHistory: () => {
				rendersBeforeLoad.push(renders);
				olderBatches -= 1;
				lineCount += 5;
				return Promise.resolve(true);
			},
			render: () => { renders += 1; },
		});

		assert.equal(await controller.scrollToAbsoluteTop(), true);
		assert.equal(olderBatches, 0);
		assert.deepEqual(rendersBeforeLoad, [0, 1]);
		assert.equal(renders, 2);
		assert.equal(controller.conversationView(10, 5).metrics.start, 0);
	});
});

function createController(viewport: {
	lineCount(width: number): number;
	slice(width: number, start: number, count: number): { text: string }[];
	entries?: () => unknown[];
	entryBlockPositionById?: (width: number, entryId: string) => unknown;
	entryBlockPositions?: (width: number) => unknown[];
	measuredLineCountForEntries?: (width: number, entryIds: readonly string[]) => number;
}, bodyHeight = 1, hostOverrides: Partial<AppScrollControllerHost> = {}): AppScrollController {
	return new AppScrollController({
		conversationViewport: () => viewport as unknown as ConversationViewport,
		editorLayoutRenderer: () => ({
			computeLayout: () => ({ bodyHeight }),
		}) as unknown as EditorLayoutRenderer,
		terminalColumns: () => 10,
		terminalRows: () => 4,
		tabPanelRows: () => 0,
		render: () => undefined,
		...hostOverrides,
	});
}

function entryPosition(entryId: string, offset: number, lines: readonly string[]) {
	return {
		entry: { id: entryId, kind: "assistant", text: lines.join("\n") },
		offset,
		lineCount: lines.length,
		block: {
			version: 1,
			lineCount: lines.length,
			lines: lines.map((text) => ({ text })),
		},
	};
}
