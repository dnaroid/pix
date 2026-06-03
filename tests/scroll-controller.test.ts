import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { ConversationViewport } from "../src/app/rendering/conversation-viewport.js";
import type { EditorLayoutRenderer } from "../src/app/rendering/editor-layout-renderer.js";
import { AppScrollController } from "../src/app/screen/scroll-controller.js";

describe("AppScrollController", () => {
	it("uses one less conversation column when a scrollbar is needed", () => {
		let slicedWidth: number | undefined;
		const controller = createController({
			lineCount: (width) => width === 10 ? 2 : 3,
			slice: (width) => {
				slicedWidth = width;
				return [{ text: "visible" }];
			},
		});

		const view = controller.conversationView(10, 1);

		assert.equal(view.metrics.viewportColumns, 9);
		assert.equal(view.metrics.conversationLineCount, 3);
		assert.equal(slicedWidth, 9);
	});

	it("does not create a scrollbar only because the gutter would wrap content", () => {
		const controller = createController({
			lineCount: (width) => width === 10 ? 1 : 2,
			slice: () => [{ text: "visible" }],
		});

		const view = controller.conversationView(10, 1);

		assert.equal(view.metrics.viewportColumns, 10);
		assert.equal(controller.scrollBarForMetrics(view.metrics), undefined);
	});

	it("scrolls to the rendered line containing a text sample", () => {
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => 8,
			slice: (_width, start) => {
				slicedStart = start;
				return [{ text: "visible" }];
			},
			entryBlockPositions: () => [
				entryPosition("entry-1", 0, ["alpha", "beta"]),
				entryPosition("entry-2", 3, ["start", "the needle sample is here", "end"]),
			],
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
			entryBlockPositions: () => [
				entryPosition("entry-1", 0, ["earlier needle sample", "beta"]),
				entryPosition("entry-2", 3, ["start", "different text", "end"]),
			],
		});

		assert.equal(controller.scrollToConversationText({ entryId: "entry-2", needles: ["needle sample"] }), true);
		controller.conversationView(10, 2);

		assert.equal(slicedStart, 3);
	});
	it("maps scrollbar clicks to conversation starts", () => {
		let slicedStart: number | undefined;
		const controller = createController({
			lineCount: () => 20,
			slice: (_width, start) => {
				slicedStart = start;
				return [{ text: "visible" }];
			},
		}, 5);

		assert.equal(controller.scrollToScrollbarPosition(0), true);
		controller.conversationView(10, 5);
		assert.equal(slicedStart, 0);

		assert.equal(controller.scrollToScrollbarPosition(4), true);
		controller.conversationView(10, 5);
		assert.equal(slicedStart, 15);
	});

	it("requests older history when scrolling above the loaded top", () => {
		let olderHistoryRequests = 0;
		const controller = createController({
			lineCount: () => 5,
			slice: () => [{ text: "visible" }],
		}, 5, async () => {
			olderHistoryRequests += 1;
		});

		assert.equal(controller.scrollByLines(-1), false);
		assert.equal(olderHistoryRequests, 1);
	});

});

function createController(viewport: {
	lineCount(width: number): number;
	slice(width: number, start: number, count: number): { text: string }[];
	entryBlockPositions?: (width: number) => unknown[];
}, bodyHeight = 1, loadOlderSessionHistory: () => Promise<void> = async () => undefined): AppScrollController {
	return new AppScrollController({
		conversationViewport: () => viewport as unknown as ConversationViewport,
		editorLayoutRenderer: () => ({
			computeLayout: () => ({ bodyHeight }),
		}) as unknown as EditorLayoutRenderer,
		terminalColumns: () => 10,
		terminalRows: () => 4,
		tabPanelRows: () => 0,
		loadOlderSessionHistory,
		requestRender: () => undefined,
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
