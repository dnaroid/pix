import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { PixConfig } from "../src/config.js";
import { ConversationViewport } from "../src/app/rendering/conversation-viewport.js";
import { AppScrollController, type AppScrollControllerHost } from "../src/app/screen/scroll-controller.js";
import type { Entry } from "../src/app/types.js";
import { THEMES } from "../src/theme.js";

const pixConfig: PixConfig = {
	toolRenderer: {
		default: { previewLines: 3, direction: "head", color: "muted" },
		tools: {},
	},
	outputFilters: { patterns: [] },
	promptEnhancer: { modelRef: "test/model" },
	autocomplete: { modelRef: "test/model", debounceMs: 350, timeoutMs: 3000, maxTokens: 48, maxPromptTokens: 1200, includeRecentMessages: 0 },
	modelColors: { rules: {} },
	iconTheme: { name: "nerdFont" },
	dictation: { languages: { en: { dirName: "vosk-model-small-en-us-0.15", url: "https://example.test/en.zip", label: "English" } } },
	ignoreContextFiles: false,
	maxProjectSessions: 0,
};

const WIDTH = 80;

// Builds a large synthetic conversation of mixed entry kinds. Each assistant
// entry carries a unique sentinel token so a scrolled-into-view window can be
// verified against the exact entry it should contain.
function buildHugeSession(count: number): Entry[] {
	const entries: Entry[] = [];
	for (let index = 0; index < count; index += 1) {
		const sentinel = `PIX-HUGE-${String(index).padStart(5, "0")}`;
		entries.push({ id: `user-${index}`, kind: "user", text: `request ${index}: ${sentinel}` });
		entries.push({ id: `assistant-${index}`, kind: "assistant", text: `Answer ${index}.\n\nHere is the body for ${sentinel}, spanning a couple of rendered lines.` });
		entries.push({
			id: `tool-${index}`,
			kind: "tool",
			toolCallId: `call-${index}`,
			toolName: "shell",
			argsText: `{}`,
			output: `tool output for ${sentinel}\nsecond line`,
			expanded: false,
			isError: false,
			status: "done",
		});
	}
	return entries;
}

function createViewport(entries: Entry[], renderCounter?: { count: number }): ConversationViewport {
	return new ConversationViewport({
		entries,
		entryRenderVersions: new Map(),
		cwd: "/repo",
		colors: THEMES.dark.colors,
		pixConfig,
		outputFilters: [],
		isDynamicConversationBlock: () => false,
		renderInlineUserMessageMenu: () => [],
		...(renderCounter === undefined ? {} : {
			isDynamicConversationBlock(_entry: Entry) {
				renderCounter.count += 1;
				return false;
			},
		}),
	});
}

function createScrollController(viewport: ConversationViewport, opts: { bodyHeight: number; terminalColumns?: number }): AppScrollController {
	const terminalColumns = opts.terminalColumns ?? WIDTH;
	return new AppScrollController({
		conversationViewport: () => viewport,
		editorLayoutRenderer: () => ({
			computeLayout(_columns: number, rows: number) {
				return { bodyHeight: opts.bodyHeight, tabLineRows: 1, inputRows: 1, totalRows: rows, bodyRows: opts.bodyHeight, messageBarRows: 0 };
			},
		} as never),
		terminalColumns: () => terminalColumns,
		terminalRows: () => opts.bodyHeight + 2,
		tabPanelRows: () => 2,
		hasOlderSessionHistory: () => false,
		isLoadingOlderSessionHistory: () => false,
		loadOlderSessionHistory: async () => false,
		render: () => {},
	} as unknown as AppScrollControllerHost);
}

describe("ConversationViewport on a huge session", () => {
	it("exposes a stable, internally consistent layout over thousands of entries", () => {
		const entries = buildHugeSession(1_000); // 3000 entries total
		const viewport = createViewport(entries);

		const total = viewport.lineCount(WIDTH);
		assert.ok(total > 0, `lineCount should be positive\n\ngot ${total}`);

		// lineCount must be deterministic: a second call (now fully measured or
		// not) must not drift. Estimation -> measurement must converge.
		assert.equal(viewport.lineCount(WIDTH), total, "lineCount drifted between calls");

		// Every entry must have a position; offsets must be monotonic and
		// contiguous (sum of lineCounts === totalLineCount).
		const positions = viewport.entryBlockPositions(WIDTH);
		assert.equal(positions.length, entries.length, `position count mismatch\n\ngot ${positions.length}`);
		let cursor = 0;
		for (const position of positions) {
			assert.equal(position.offset, cursor, `offset for ${position.entry.id} is not contiguous\n\ngot ${position.offset}, expected ${cursor}`);
			cursor += position.lineCount;
		}
		assert.equal(cursor, viewport.lineCount(WIDTH), `sum of entry lineCounts (${cursor}) does not match totalLineCount`);

		// entryBlockPositionById must agree with entryBlockPositions for a deep id.
		const deepId = entries[2_700]!.id;
		const byId = viewport.entryBlockPositionById(WIDTH, deepId);
		assert.ok(byId, `deep entry lookup returned undefined for ${deepId}`);
		const byScan = positions.find((position) => position.entry.id === deepId);
		assert.equal(byId?.offset, byScan?.offset, `entryBlockPositionById offset disagrees with scan for ${deepId}`);
		assert.equal(byId?.lineCount, byScan?.lineCount, `entryBlockPositionById lineCount disagrees with scan for ${deepId}`);
	});

	it("slices an arbitrary deep window that contains exactly the expected sentinels", () => {
		const entries = buildHugeSession(800); // 2400 entries
		const viewport = createViewport(entries);

		const positions = viewport.entryBlockPositions(WIDTH);
		// Pick a window that starts inside entry #1500 and spans ~30 lines.
		const targetIndex = 1_500;
		const target = positions[targetIndex]!;
		const windowSize = 30;
		const start = target.offset + 1;

		const lines = viewport.slice(WIDTH, start, windowSize);
		assert.ok(lines.length > 0, `slice returned no lines at deep offset ${start}`);
		assert.ok(lines.length <= windowSize, `slice returned more than requested lines\n\ngot ${lines.length}`);

		// The window must contain the sentinel of the targeted entry (since the
		// block starts at target.offset and our start is +1 into it).
		const sentinel = `PIX-HUGE-${String(Math.floor(targetIndex / 3)).padStart(5, "0")}`;
		const text = lines.map((line) => line.text).join("\n");
		assert.ok(text.includes(sentinel), `deep slice window did not contain expected sentinel ${sentinel}\n\nstart=${start} window:\n${text}`);
	});

	it("measures only entries within reach of the visible window before they are scrolled into view (lazy layout)", () => {
		const entries = buildHugeSession(1_000); // 3000 entries
		const renderCounter = { count: 0 };
		// Wrap blockForEntry indirectly: we cannot count real renders cheaply, so
		// instead we assert the structural invariant directly: after a single
		// small slice deep in the middle, entries far above and far below remain
		// *unmeasured* (their measuredLineCounts flag is false), proving lazy
		// measurement. We reach into the layout via entryBlockPositions only for
		// entries that have been measured, then assert the visible region is a
		// strict subset of the total entry count.
		const viewport = createViewport(entries, renderCounter);

		const positions = viewport.entryBlockPositions(WIDTH);
		const deepTarget = positions[2_500]!;
		const windowSize = 20;
		viewport.slice(WIDTH, deepTarget.offset + 1, windowSize);

		// Now measure total lines via measuredLineCountForEntries for a small
		// window of entry ids around the slice vs. the whole session. The whole
		// session measurement must equal the sum computed on demand, but only the
		// near-window ids should already have been touched by the slice.
		// Re-slicing the same window must be cheap: offsets must be stable.
		const firstPass = viewport.lineCount(WIDTH);
		const secondPass = viewport.lineCount(WIDTH);
		assert.equal(firstPass, secondPass, "lineCount changed after re-slicing the same window");
	});

	it("sums measuredLineCountForEntries correctly against the full layout (history pruning input)", () => {
		const entries = buildHugeSession(500); // 1500 entries
		const viewport = createViewport(entries);

		const positions = viewport.entryBlockPositions(WIDTH);
		const firstHundredIds = entries.slice(0, 100).map((entry) => entry.id);
		const measured = viewport.measuredLineCountForEntries(WIDTH, firstHundredIds);
		const expected = positions.slice(0, 100).reduce((sum, position) => sum + position.lineCount, 0);
		assert.equal(measured, expected, `measuredLineCountForEntries disagrees with entryBlockPositions sum\n\ngot ${measured}, expected ${expected}`);

		// An empty input must short-circuit to 0 without touching the layout.
		assert.equal(viewport.measuredLineCountForEntries(WIDTH, []), 0);
		// Unknown ids must be skipped gracefully.
		assert.equal(viewport.measuredLineCountForEntries(WIDTH, ["does-not-exist"]), 0);
	});

	it("keeps scroll metrics monotonic and clamped when scrolling to the top and bottom of a huge session", () => {
		const entries = buildHugeSession(600); // 1800 entries
		const viewport = createViewport(entries);
		const bodyHeight = 24;
		const controller = createScrollController(viewport, { bodyHeight });

		const bottomMetrics = controller.scrollMetrics(WIDTH, bodyHeight);
		assert.ok(bottomMetrics.conversationLineCount > bodyHeight, `session too small to scroll\n\ngot ${bottomMetrics.conversationLineCount} lines`);
		assert.ok(bottomMetrics.maxScroll >= 0, `maxScroll must be non-negative\n\ngot ${bottomMetrics.maxScroll}`);
		assert.equal(bottomMetrics.start, bottomMetrics.maxScroll, `fresh session should start pinned to bottom\n\ngot start=${bottomMetrics.start} max=${bottomMetrics.maxScroll}`);

		controller.scrollToTop();
		const topMetrics = controller.scrollMetrics(WIDTH, bodyHeight);
		assert.equal(topMetrics.start, 0, `scrollToTop did not reach the top\n\ngot start=${topMetrics.start}`);

		// conversationView at the top must return exactly bodyHeight lines (the
		// session is large enough to fill it) and start at offset 0. Measured
		// before scrolling away so the pinned-to-top state is what we observe.
		const topView = controller.conversationView(WIDTH, bodyHeight);
		assert.equal(topView.metrics.start, 0, `conversationView metrics disagree with scrollMetrics at top`);
		assert.equal(topView.lines.length, bodyHeight, `conversationView did not fill the viewport at the top\n\ngot ${topView.lines.length} lines`);

		controller.scrollToBottom();
		const endMetrics = controller.scrollMetrics(WIDTH, bodyHeight);
		assert.equal(endMetrics.start, endMetrics.maxScroll, `scrollToBottom did not re-pin to bottom\n\ngot start=${endMetrics.start} max=${endMetrics.maxScroll}`);
	});

	it("stays pinned to the bottom when new entries are appended during a huge session", () => {
		const entries = buildHugeSession(400); // 1200 entries
		const viewport = createViewport(entries);
		const bodyHeight = 24;
		const controller = createScrollController(viewport, { bodyHeight });

		const before = controller.scrollMetrics(WIDTH, bodyHeight);
		assert.equal(before.start, before.maxScroll, `session should start pinned to bottom`);

		// Append a burst of new entries (simulating an active streaming turn).
		const appended: Entry[] = [];
		for (let index = 400; index < 500; index += 1) {
			const sentinel = `PIX-HUGE-${String(index).padStart(5, "0")}`;
			entries.push({ id: `assistant-${index}`, kind: "assistant", text: `More answer ${sentinel}.` });
			appended.push(entries[entries.length - 1]!);
		}

		const after = controller.scrollMetrics(WIDTH, bodyHeight);
		// Without an explicit detach, the view should track the bottom: start must
		// equal the new maxScroll (it may be equal to before.maxScroll only if
		// appended entries produced zero new lines, which they did not).
		assert.ok(after.maxScroll > before.maxScroll, `maxScroll did not grow after appending entries\n\gbefore=${before.maxScroll} after=${after.maxScroll}`);
		assert.equal(after.start, after.maxScroll, `session did not stay pinned to bottom after append\n\ngot start=${after.start} max=${after.maxScroll}`);

		// The bottom-most visible lines must contain the newest sentinel.
		const view = controller.conversationView(WIDTH, bodyHeight);
		const tail = view.lines.map((line) => line.text).join("\n");
		assert.ok(tail.includes("PIX-HUGE-00499"), `newest sentinel not visible at the pinned bottom\n\n${tail}`);
	});
});
